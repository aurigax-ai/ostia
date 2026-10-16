import {
  type CommandHandler,
  type ExtensionEventType,
  type ExtensionSettingValues,
  booleanSetting,
  cliArgs,
  connect,
  createTranslator,
  failure,
  numberSetting,
  ok,
  startPanelServer,
} from '@aurigax-ai/ostia-extension-sdk'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { ARCHIVE_DAYS, DAY_MS, Journal, RETENTION_DAYS, type Retention } from './journal'
import { createNeedsYou } from './needsYou'
import { type PanelCommand, SHOW_ACTIVITY, activityPanelCommands } from './panelCommands'
import { Recorder } from './recorder'
import { activityVerbs } from './verbs'
import type { OpenWorkspace } from './view'

const PANEL_FILES = ['panel.html', 'panel.js', 'panel.css', 'base.css']
const EVENTS: ExtensionEventType[] = ['pane.closed']
const PRUNE_EVERY_MS = 60 * 60 * 1000

function retentionOf(values: ExtensionSettingValues): Retention {
  const liveDays = numberSetting(values, 'retentionDays', RETENTION_DAYS, { min: 1, max: 365 })
  const archiveDays = numberSetting(values, 'archiveDays', ARCHIVE_DAYS, { min: 1, max: 3650 })
  return { liveMs: liveDays * DAY_MS, archiveMs: archiveDays * DAY_MS }
}

interface ListedWorkspace extends OpenWorkspace {
  kind: string
}

function listedWorkspaces(raw: unknown): ListedWorkspace[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (w): w is ListedWorkspace =>
        typeof w?.workspaceId === 'string' &&
        typeof w?.name === 'string' &&
        typeof w?.kind === 'string',
    )
    .map((w) => ({ workspaceId: w.workspaceId, name: w.name, kind: w.kind }))
}

async function main(): Promise<void> {
  const ext = await connect()
  const panelHandlers: Record<string, PanelCommand> = {}
  const panelStarting = startPanelServer({
    dir: __dirname,
    files: PANEL_FILES,
    handle: async (command, args, caller) => {
      const handler = panelHandlers[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  let handlersAssigned = (): void => {}
  const handlersReady = new Promise<void>((resolve) => {
    handlersAssigned = resolve
  })
  ext.onPanel(async (caller) => {
    await handlersReady
    return {
      url: (await panelStarting).url({
        workspaceId: caller.workspaceId ?? '',
        locale: caller.locale ?? '',
      }),
    }
  })
  const journal = new Journal({ dir: readEnv('EXTENSION_DATA') ?? null, now: Date.now })
  const translate = createTranslator()
  const state = { locale: 'en', showActivity: false }
  let panelChanged = (): void => {}
  const settingsLoaded = ext.getSettings().then((values) => {
    state.showActivity = booleanSetting(values, SHOW_ACTIVITY, false)
    journal.setRetention(retentionOf(values))
  })
  await settingsLoaded
  journal.load()
  const showNeedsYou = createNeedsYou({ ext, journal, translate, state })
  const changed = (): void => {
    panelChanged()
    void showNeedsYou()
  }
  let workspaces: ListedWorkspace[] = []

  const refreshWorkspaces = async (): Promise<ListedWorkspace[] | null> => {
    try {
      workspaces = listedWorkspaces(await ext.listWorkspaces())
    } catch {
      return null
    }
    journal.dropClosedMemory(new Set(workspaces.map((w) => w.workspaceId)))
    return workspaces
  }

  const workspaceKind = async (workspaceId: string): Promise<string | null> => {
    const known = workspaces.find((w) => w.workspaceId === workspaceId)
    if (known) return known.kind
    const listed = await refreshWorkspaces()
    return listed?.find((w) => w.workspaceId === workspaceId)?.kind ?? null
  }

  const recorder = new Recorder({
    journal,
    now: Date.now,
    redact: (texts) => ext.redact(texts),
    workspaceKind,
    changed,
  })

  Object.assign(
    panelHandlers,
    activityPanelCommands({ ext, journal, state, settingsLoaded, refreshWorkspaces, changed }),
  )
  handlersAssigned()

  await settingsLoaded
  const panel = await panelStarting
  panelChanged = () => panel.changed()

  ext.onSettingsChanged((values) => {
    state.showActivity = booleanSetting(values, SHOW_ACTIVITY, false)
    journal.setRetention(retentionOf(values))
    journal.prune()
    changed()
  })
  state.locale = await ext.getLocale()
  ext.onLocaleChanged((next) => {
    state.locale = next
    void showNeedsYou()
  })

  const handlers: Record<string, CommandHandler> = {
    ...activityVerbs({
      journal,
      now: Date.now,
      redact: (texts) => ext.redact(texts),
      workspaceKind,
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
  await ext.registerCommands(handlers)

  await ext.subscribe(EVENTS, () => {
    void refreshWorkspaces().then(() => panel.changed())
  })
  await refreshWorkspaces()
  journal.prune()
  await showNeedsYou()
  setInterval(() => {
    if (journal.prune()) changed()
  }, PRUNE_EVERY_MS).unref()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
