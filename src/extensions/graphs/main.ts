import {
  type CommandHandler,
  type ExtensionEventType,
  type ExtensionResult,
  type ExtensionSettingValues,
  connect,
  createTranslator,
  failure,
  numberSetting,
  ok,
  startPanelServer,
} from '@aurigax-ai/ostia-extension-sdk'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { HOUR_MS, realClock } from '@aurigax-ai/wire'
import { createPaneSignals } from './paneSignals'
import { panelHandlers } from './panelHandlers'
import { GraphsRunner, type Workspace } from './runner'
import { TriggerHost } from './triggers'
import { graphVerbs } from './verbs'

const PANEL_FILES = ['panel.html', 'panel.js', 'panel.css', 'base.css']
const EVENTS: ExtensionEventType[] = [
  'pane.closed',
  'command.finished',
  'pane.created',
  'pane.attention',
]

function workspacesOf(raw: unknown): Workspace[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((w) => typeof w?.workspaceId === 'string' && typeof w?.workDir === 'string')
    .map((w) => ({
      workspaceId: w.workspaceId,
      workDir: w.workDir,
      kind: String(w.kind ?? ''),
      ...(w.sandboxed === true ? { sandboxed: true } : {}),
    }))
}

function ceilingsOf(values: ExtensionSettingValues) {
  return {
    steps: numberSetting(values, 'maxSteps', 500, { min: 1, max: 500 }),
    runsPerHour: numberSetting(values, 'maxRunsPerHour', 60, { min: 1, max: 60 }),
    parallel: numberSetting(values, 'maxParallel', 8, { min: 1, max: 8 }),
    agents: numberSetting(values, 'maxAgentsPerRun', 24, { min: 0, max: 24 }),
    timeMs: numberSetting(values, 'maxRunHours', 168, { min: 1, max: 168 }) * HOUR_MS,
  }
}

async function main(): Promise<void> {
  const ext = await connect()
  const translate = createTranslator()
  let locale = 'en'
  let panelChanged = (): void => {}
  let sidebarTimer: ReturnType<typeof setTimeout> | null = null
  const runner = new GraphsRunner({
    ext,
    dataDir: readEnv('EXTENSION_DATA') ?? null,
    clock: realClock,
    changed: () => {
      panelChanged()
      if (!sidebarTimer) sidebarTimer = setTimeout(() => void showActive(), 300)
    },
  })
  const triggers = new TriggerHost({
    clock: realClock,
    dataDir: readEnv('EXTENSION_DATA') ?? null,
    enabled: () => runner.enabledGraphs(),
    fire: (graph, payload) => void runner.fire(graph, payload),
    ownPane: (workspaceId, graph, pane) => runner.ownPane(workspaceId, graph, pane),
    changed: () => panelChanged(),
  })
  const shown = new Set<string>()
  let startsWithWindow: boolean | null = null
  const keepStarting = async (): Promise<void> => {
    const needed = runner.hasUnfinishedRuns() || triggers.needsLiveHost()
    if (needed === startsWithWindow) return
    startsWithWindow = needed
    await ext.startWithWindow(needed).catch(() => {})
  }
  const showActive = async (): Promise<void> => {
    sidebarTimer = null
    await keepStarting()
    const counts = new Map<string, number>()
    for (const run of runner.engine.active())
      counts.set(run.state.scope, (counts.get(run.state.scope) ?? 0) + 1)
    for (const workspaceId of new Set([...shown, ...counts.keys()])) {
      const count = counts.get(workspaceId) ?? 0
      if (count === 0) shown.delete(workspaceId)
      else shown.add(workspaceId)
      await ext
        .setSidebarItem({
          key: 'runs',
          workspaceId,
          text: count > 0 ? translate(locale)('sidebar.active', { count }) : '',
          badge: String(count),
          icon: 'graph',
          tone: 'brand',
        })
        .catch(() => {})
    }
  }
  const refresh = async (): Promise<void> => {
    try {
      const [workspaces, connections, servers] = await Promise.all([
        ext.listWorkspaces(),
        ext.connections(),
        ext.mcpServers(),
      ])
      if (connections.ok) runner.setConnections(connections.connections)
      runner.setMcpGranted(servers.ok || !servers.error.includes('needs-elevation'))
      runner.setWorkspaces(workspacesOf(workspaces))
      triggers.refresh()
      await keepStarting()
    } catch {}
  }
  const handlers = panelHandlers(runner, ext, refresh, (id) => triggers.filesRefused(id))
  const panelStarting = startPanelServer({
    dir: __dirname,
    files: PANEL_FILES,
    handle: async (command, args): Promise<ExtensionResult> => {
      const handler = handlers[command]
      return handler ? handler(args) : failure('unknown-command', command)
    },
  })
  ext.onPanel(async (caller, path) => {
    const run = path ? new URLSearchParams(path.replace(/^[^?]*\?/, '')).get('run') : null
    return {
      url: (await panelStarting).url({
        workspaceId: caller.workspaceId ?? '',
        locale: caller.locale ?? '',
        ...(run ? { run } : {}),
      }),
    }
  })
  locale = await ext.getLocale()
  ext.onLocaleChanged((next) => {
    locale = next
  })
  runner.engine.ceilings = ceilingsOf(await ext.getSettings())
  ext.onConnectionsChanged(() => void refresh())
  ext.onSettingsChanged((values) => {
    runner.engine.ceilings = ceilingsOf(values)
  })
  const panel = await panelStarting
  panelChanged = () => panel.changed()

  const signals = createPaneSignals({ ext, runner, triggers, refresh })

  const commands: Record<string, CommandHandler> = {
    ...graphVerbs(runner, refresh, ext),
    open: async (_args, caller) => {
      await ext.openPanel(caller.workspaceId)
      return ok()
    },
    'on-stop': signals.onStop,
  }
  await ext.registerCommands(commands)
  await ext.subscribe(EVENTS, signals.onEvent)
  await refresh()
  await keepStarting()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
