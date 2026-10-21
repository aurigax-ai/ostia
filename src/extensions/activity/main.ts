import { join } from 'node:path'
import {
  booleanSetting,
  type CommandHandler,
  cliArgs,
  connect,
  createTranslator,
  type ExtensionSettingValues,
  failure,
  numberSetting,
  ok,
  startPanelServer,
} from '@aurigax-ai/ostia-extension-sdk'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { isRecordId } from './hookEvent'
import { BUS_EVENT, HOST_EVENTS, HostRecorder, type HostWorkspace } from './hostRecorder'
import { ARCHIVE_DAYS, DAY_MS, HOST_DIR, Journal, RETENTION_DAYS, type Retention } from './journal'
import { createNeedsYou } from './needsYou'
import { createOpenListing } from './openListing'
import { activityPanelCommands, type PanelCommand, SHOW_ACTIVITY } from './panelCommands'
import { coalesced, PUSH_WINDOW_MS } from './panelPush'
import { Recorder } from './recorder'
import { RememberStore } from './remember'
import { REMEMBER_DAYS } from './rememberItem'
import { rememberVerbs } from './rememberVerbs'
import { sessionHook } from './sessionHook'
import { activityVerbs } from './verbs'
import type { OpenWorkspace } from './view'

const PANEL_FILES = ['panel.html', 'panel.js', 'panel.css', 'base.css']
const PRUNE_EVERY_MS = 60 * 60 * 1000

function rememberDaysOf(values: ExtensionSettingValues): number {
  return numberSetting(values, 'rememberDays', REMEMBER_DAYS, { min: 1, max: 365 })
}

function retentionOf(values: ExtensionSettingValues): Retention {
  const liveDays = numberSetting(values, 'retentionDays', RETENTION_DAYS, { min: 1, max: 365 })
  const archiveDays = numberSetting(values, 'archiveDays', ARCHIVE_DAYS, { min: 1, max: 3650 })
  return { liveMs: liveDays * DAY_MS, archiveMs: archiveDays * DAY_MS }
}

interface ListedWorkspace extends OpenWorkspace {
  kind: string
  workDir: string
  sandboxed?: boolean
}

function listedWorkspaces(raw: unknown): ListedWorkspace[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (w): w is ListedWorkspace =>
        typeof w?.workspaceId === 'string' &&
        typeof w?.name === 'string' &&
        typeof w?.kind === 'string' &&
        typeof w?.workDir === 'string',
    )
    .map((w) => ({
      workspaceId: w.workspaceId,
      name: w.name,
      kind: w.kind,
      workDir: w.workDir,
      ...(w.sandboxed === true ? { sandboxed: true } : {}),
    }))
}

async function main(): Promise<void> {
  const ext = await connect()
  const panelHandlers: Record<string, PanelCommand> = {}
  const panelStarting = startPanelServer({
    dir: __dirname,
    files: PANEL_FILES,
    toolbar: (toolbar) => ext.setPanelToolbar(toolbar),
    handle: async (command, args, caller) => {
      const handler = panelHandlers[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  let handlersAssigned = (): void => {}
  const handlersReady = new Promise<void>((resolve) => {
    handlersAssigned = resolve
  })
  ext.onPanel(async (caller, path) => {
    await handlersReady
    return {
      url: (await panelStarting).url({
        workspaceId: caller.workspaceId ?? '',
        locale: caller.locale ?? '',
        ...(path === 'parked' ? { tab: 'parked' } : {}),
      }),
    }
  })
  const dataDir = readEnv('EXTENSION_DATA') ?? null
  const journal = new Journal({ dir: dataDir, now: Date.now })
  const hostJournal = new Journal({ dir: dataDir ? join(dataDir, HOST_DIR) : null, now: Date.now })
  const journals = [journal, hostJournal]
  const translate = createTranslator()
  const state = { locale: 'en', showActivity: false, rememberDays: REMEMBER_DAYS }
  const remembered = new RememberStore({ dir: dataDir, now: Date.now })
  let panelChanged = (): void => {}
  const settingsLoaded = ext.getSettings().then((values) => {
    state.showActivity = booleanSetting(values, SHOW_ACTIVITY, false)
    state.rememberDays = rememberDaysOf(values)
    for (const j of journals) j.setRetention(retentionOf(values))
  })
  await settingsLoaded
  for (const j of journals) j.load()
  remembered.load()
  const showNeedsYou = createNeedsYou({ ext, journal, translate, state })
  const changed = coalesced(
    () => {
      panelChanged()
      void showNeedsYou()
    },
    PUSH_WINDOW_MS,
    {
      now: Date.now,
      after: (ms, run) => {
        setTimeout(run, ms).unref()
      },
    },
  )
  let workspaces: ListedWorkspace[] = []

  let retrySubscribe = async (): Promise<void> => {}

  const refreshWorkspaces = async (): Promise<ListedWorkspace[] | null> => {
    try {
      workspaces = listedWorkspaces(await ext.listWorkspaces())
    } catch {
      return null
    }
    const open = new Set(workspaces.map((w) => w.workspaceId))
    for (const j of journals) j.dropClosedMemory(open)
    remembered.dropClosedMemory(open)
    void retrySubscribe()
    return workspaces
  }

  const listing = createOpenListing({
    listWorkspaces: refreshWorkspaces,
    listPanes: () => ext.listPanes(),
    now: Date.now,
  })

  const workspaceInfo = async (workspaceId: string): Promise<ListedWorkspace | null> => {
    const known = workspaces.find((w) => w.workspaceId === workspaceId)
    if (known) return known
    const listed = await refreshWorkspaces()
    return listed?.find((w) => w.workspaceId === workspaceId) ?? null
  }

  const workspaceKind = async (workspaceId: string): Promise<string | null> =>
    (await workspaceInfo(workspaceId))?.kind ?? null

  const recorder = new Recorder({
    journal,
    now: Date.now,
    redact: (texts) => ext.redact(texts),
    workspaceKind,
    changed,
  })

  const hostRecorder = new HostRecorder({
    journal: hostJournal,
    now: Date.now,
    redact: (texts) => ext.redact(texts),
    workspace: async (workspaceId): Promise<HostWorkspace | null> => workspaceInfo(workspaceId),
    changed,
  })

  Object.assign(
    panelHandlers,
    activityPanelCommands({
      ext,
      journal,
      hostJournal,
      remembered,
      state,
      settingsLoaded,
      listing,
      changed,
      opened: () => void showNeedsYou(),
    }),
  )
  handlersAssigned()

  await settingsLoaded
  const panel = await panelStarting
  panelChanged = () => panel.changed()

  ext.onSettingsChanged((values) => {
    state.showActivity = booleanSetting(values, SHOW_ACTIVITY, false)
    state.rememberDays = rememberDaysOf(values)
    for (const j of journals) j.setRetention(retentionOf(values))
    for (const j of journals) j.prune()
    remembered.expire(Date.now(), state.rememberDays)
    changed()
  })
  state.locale = await ext.getLocale()
  ext.onLocaleChanged((next) => {
    state.locale = next
    void showNeedsYou()
  })

  const paneSession = async (paneId: string) => {
    const panes = await ext.listPanes()
    const pane = panes.find((p) => p.paneId === paneId)
    return pane?.agent && pane.agentSessionId
      ? { agent: pane.agent, session: pane.agentSessionId }
      : null
  }
  const rememberedVerbs = rememberVerbs({
    store: remembered,
    now: Date.now,
    redact: (texts) => ext.redact(texts),
    workspaceKind,
    paneSession,
    changed,
  })
  const handlers: Record<string, CommandHandler> = {
    ...activityVerbs({
      journal,
      now: Date.now,
      redact: (texts) => ext.redact(texts),
      workspaceKind,
      changed,
      remembered: rememberedVerbs,
    }),
    remember: rememberedVerbs.remember,
    'on-session': sessionHook({
      store: remembered,
      paneSession,
      now: Date.now,
      days: () => state.rememberDays,
      changed,
    }),
    open: async (_args, caller) => {
      await ext.openPanel(caller.workspaceId)
      return ok()
    },
    'on-hook': async (args, caller) => {
      const parsed = cliArgs(args)
      if (parsed?.stdin !== undefined) recorder.accept(parsed.argv, parsed.stdin, caller)
      return ok()
    },
  }
  ext.onInboxAction(({ workspaceId, id, action }) => {
    if (action !== 'done' || !isRecordId(id)) return
    if (journal.markDone(workspaceId, id, Date.now())) changed()
  })
  await ext.registerCommands(handlers)

  const onEvent: Parameters<typeof ext.subscribe>[1] = (type, payload) => {
    if (type.startsWith('pane.')) listing.invalidate()
    if (type === 'pane.closed') {
      hostRecorder.accept(type, payload)
      changed()
    } else if (type === 'pane.created') {
      void refreshWorkspaces().then(() => hostRecorder.accept(type, payload))
    } else {
      hostRecorder.accept(type, payload)
    }
  }
  await ext.subscribe([...HOST_EVENTS], onEvent)
  let busSubscribed = false
  const subscribeBus = async (): Promise<void> => {
    if (busSubscribed) return
    const res = (await ext.subscribe([BUS_EVENT], onEvent).catch(() => null)) as {
      ok?: boolean
    } | null
    busSubscribed = res?.ok === true
  }
  await subscribeBus()
  retrySubscribe = subscribeBus
  await refreshWorkspaces()
  for (const j of journals) j.prune()
  await showNeedsYou()
  remembered.expire(Date.now(), state.rememberDays)
  setInterval(() => {
    const pruned = journals.map((j) => j.prune()).some(Boolean)
    const expired = remembered.expire(Date.now(), state.rememberDays)
    if (pruned || expired) changed()
  }, PRUNE_EVERY_MS).unref()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
