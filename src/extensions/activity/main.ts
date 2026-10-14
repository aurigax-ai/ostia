import { readEnv } from '../../shared/appEnv'
import {
  type CommandHandler,
  type ExtensionEventType,
  type ExtensionResult,
  booleanSetting,
  cliArgs,
  connect,
  failure,
  namedArgs,
  ok,
  startPanelServer,
} from '../sdk'
import { Journal } from './journal'
import { Recorder } from './recorder'
import { type OpenPane, type OpenWorkspace, panelModel } from './view'

const PANEL_FILES = ['panel.html', 'panel.js', 'panel.css', 'base.css']
const SHOW_ACTIVITY = 'showActivity'
const EVENTS: ExtensionEventType[] = ['pane.closed']
const PRUNE_EVERY_MS = 60 * 60 * 1000

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
  ext.onPanel(async (caller) => ({
    url: (await panelStarting).url({
      workspaceId: caller.workspaceId ?? '',
      locale: caller.locale ?? '',
    }),
  }))
  const journal = new Journal({ dir: readEnv('EXTENSION_DATA') ?? null, now: Date.now })
  journal.load()
  let panelChanged = (): void => {}
  let showActivity = false
  const settingsLoaded = ext.getSettings().then((values) => {
    showActivity = booleanSetting(values, SHOW_ACTIVITY, false)
  })
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
    changed: () => panelChanged(),
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
  })

  await settingsLoaded
  const panel = await panelStarting
  panelChanged = () => panel.changed()

  ext.onSettingsChanged((values) => {
    showActivity = booleanSetting(values, SHOW_ACTIVITY, false)
    panel.changed()
  })

  const handlers: Record<string, CommandHandler> = {
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
  setInterval(() => {
    if (journal.prune()) panel.changed()
  }, PRUNE_EVERY_MS).unref()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
