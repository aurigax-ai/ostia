import { readEnv } from '../../shared/appEnv'
import {
  type CommandHandler,
  type ExtensionEventType,
  type ExtensionResult,
  type ExtensionSettingValues,
  booleanSetting,
  cliArgs,
  connect,
  createTranslator,
  failure,
  namedArgs,
  numberSetting,
  ok,
  startPanelServer,
} from '../sdk'
import { isRecordId } from './hookEvent'
import { ARCHIVE_DAYS, DAY_MS, Journal, RETENTION_DAYS, type Retention } from './journal'
import { Recorder } from './recorder'
import { activityVerbs } from './verbs'
import { type OpenPane, type OpenWorkspace, panelModel } from './view'

const PANEL_FILES = ['panel.html', 'panel.js', 'panel.css', 'base.css']
const SHOW_ACTIVITY = 'showActivity'
const EVENTS: ExtensionEventType[] = ['pane.closed']
const PRUNE_EVERY_MS = 60 * 60 * 1000
const SIDEBAR_KEY = 'needs-you'

function retentionOf(values: ExtensionSettingValues): Retention {
  const liveDays = numberSetting(values, 'retentionDays', RETENTION_DAYS, { min: 1, max: 365 })
  const archiveDays = numberSetting(values, 'archiveDays', ARCHIVE_DAYS, { min: 1, max: 3650 })
  return { liveMs: liveDays * DAY_MS, archiveMs: archiveDays * DAY_MS }
}

type PanelCommand = (args: unknown) => Promise<ExtensionResult>

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

function listedPanes(raw: unknown): OpenPane[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is OpenPane => typeof p?.paneId === 'string')
    .map((p) =>
      typeof p.agentState === 'string'
        ? { paneId: p.paneId, agentState: p.agentState }
        : { paneId: p.paneId },
    )
}

async function main(): Promise<void> {
  const ext = await connect()
  const panelHandlers: Record<string, PanelCommand> = {}
  const panelStarting = startPanelServer({
    dir: __dirname,
    files: PANEL_FILES,
    handle: async (command, args) => {
      const handler = panelHandlers[command]
      return handler ? handler(args) : failure('unknown-command', command)
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
  let locale = 'en'
  let panelChanged = (): void => {}
  let showActivity = false
  const settingsLoaded = ext.getSettings().then((values) => {
    showActivity = booleanSetting(values, SHOW_ACTIVITY, false)
    journal.setRetention(retentionOf(values))
  })
  await settingsLoaded
  journal.load()
  const counted = new Set<string>()
  let startsWithWindow: boolean | null = null
  const showNeedsYou = async (): Promise<void> => {
    const open = journal.workspaceIds().filter((id) => journal.openNeedsYou(id).length > 0)
    for (const workspaceId of new Set([...counted, ...open])) {
      const count = journal.openNeedsYou(workspaceId).length
      if (count === 0) counted.delete(workspaceId)
      else counted.add(workspaceId)
      await ext
        .setSidebarItem({
          key: SIDEBAR_KEY,
          workspaceId,
          text: count > 0 ? translate(locale)('sidebar.needsYou', { count }) : '',
          badge: String(count),
          icon: 'alert',
          tone: 'warn',
        })
        .catch(() => {})
    }
    const keep = open.length > 0
    if (keep !== startsWithWindow) {
      startsWithWindow = keep
      await ext.startWithWindow(keep).catch(() => {})
    }
  }
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

  const snapshot = async (): Promise<ExtensionResult> => {
    await settingsLoaded
    const open = await refreshWorkspaces()
    if (!open) return failure('unavailable')
    let panes: OpenPane[]
    try {
      panes = listedPanes(await ext.listPanes())
    } catch {
      return failure('unavailable')
    }
    return ok(
      undefined,
      panelModel({
        showActivity,
        workspaces: open,
        panes,
        events: (workspaceId) => journal.events(workspaceId),
      }),
    )
  }

  Object.assign(panelHandlers, {
    snapshot,
    setShowActivity: async (args: unknown) => {
      const value = namedArgs(args).value
      if (typeof value !== 'boolean') return failure('invalid-args')
      await settingsLoaded
      const stored = await ext.setSetting(SHOW_ACTIVITY, value)
      if (stored.ok) showActivity = value
      return stored
    },
    focus: async (args: unknown) => {
      const paneId = namedArgs(args).paneId
      return typeof paneId === 'string' ? ext.focusPane(paneId) : failure('invalid-args')
    },
    done: async (args: unknown) => {
      const { workspaceId, id } = namedArgs(args)
      if (typeof workspaceId !== 'string' || !isRecordId(id)) return failure('invalid-args')
      const done = journal.markDone(workspaceId, id, Date.now())
      if (!done) return failure('unknown-entry')
      changed()
      return ok()
    },
  })
  handlersAssigned()

  await settingsLoaded
  const panel = await panelStarting
  panelChanged = () => panel.changed()

  ext.onSettingsChanged((values) => {
    showActivity = booleanSetting(values, SHOW_ACTIVITY, false)
    journal.setRetention(retentionOf(values))
    journal.prune()
    changed()
  })
  locale = await ext.getLocale()
  ext.onLocaleChanged((next) => {
    locale = next
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
