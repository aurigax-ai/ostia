import { homedir } from 'node:os'
import {
  type CommandHandler,
  type EventHandler,
  type ExtensionEventType,
  type ExtensionSettingValues,
  booleanSetting,
  cliArgs,
  connect,
  createTranslator,
  failure,
  numberSetting,
  ok,
  onShutdown,
  startPanelServer,
} from '@aurigax-ai/ostia-extension-sdk'
import { type AgentLauncher, initHere, panelHandlers } from './panelApi'
import { sessionContext } from './prompt'
import { TrellisService, type WorkspaceRef } from './service'
import { AgentTasks } from './tasks'
import {
  BOARD_PATH,
  HUMAN_ACTOR,
  TRELLIS_IDENTITY,
  VAULT_PATH,
  cardPath,
  cardRef,
  panelTarget,
} from './trellis'

const REFRESH_SECONDS = { min: 10, max: 3600 }
const EVENTS: ExtensionEventType[] = ['pane.created', 'pane.closed', 'cwd.changed']
const FOCUS_EVENT = 'focus.changed' as ExtensionEventType
const PANEL_FILES = ['panel.html', 'panel.js', 'panel.css', 'base.css']
const TASK_CHIP = 'task'

function workspacesFrom(raw: unknown): WorkspaceRef[] {
  if (!Array.isArray(raw)) throw new Error('workspace.list returned no list')
  return raw
    .filter(
      (s): s is { workspaceId: string; workDir: string } =>
        typeof s?.workspaceId === 'string' && typeof s?.workDir === 'string',
    )
    .map((s) => ({ workspaceId: s.workspaceId, workDir: s.workDir }))
}

async function main(): Promise<void> {
  process.env.TRELLIS_AGENT = HUMAN_ACTOR
  const ext = await connect()
  const translate = createTranslator()
  let panelChanged = (): void => {}
  const service = new TrellisService({
    home: homedir(),
    consumer: TRELLIS_IDENTITY,
    translate,
    host: {
      listWorkspaces: async () => workspacesFrom(await ext.call('workspace.list')),
      setWorkspaceChip: (chip) => ext.setWorkspaceChip(chip),
      clearWorkspaceChip: (workspaceId, id) => ext.clearWorkspaceChip(workspaceId, id),
      notifyPanel: (title, body, path) => ext.notifyPanel(title, body, path),
      changed: () => panelChanged(),
      log: (line) => console.error(line),
    },
  })
  onShutdown(() => service.stop())

  const tasks = new AgentTasks()
  const agents: AgentLauncher = {
    list: () => ext.listAgents(),
    run: (opts) => ext.runAgent(opts),
    offer: (opts) => ext.offerToAgent(opts),
    focus: (paneId) => ext.focusPane(paneId),
    mark: (paneId, card, locale) =>
      void ext
        .setPaneChip({
          paneId,
          id: TASK_CHIP,
          text: card.ref,
          tooltip: translate(locale)('task.chip', { ref: card.ref, title: card.title }),
        })
        .catch(() => {}),
  }
  const deps = { service, translate, confirm: ext.confirm, agents, tasks }
  const panelOnly = panelHandlers(deps)
  const panel = await startPanelServer({
    dir: __dirname,
    files: PANEL_FILES,
    handle: async (command, args, caller) => {
      const handler = panelOnly[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  panelChanged = () => panel.changed()

  service.locale = await ext.getLocale()
  ext.onLocaleChanged((locale) => {
    service.locale = locale
    void service.refreshSidebar()
  })

  const handlers: Record<string, CommandHandler> = {
    open: async (_args, caller) => {
      await ext.openPanel(caller.workspaceId, BOARD_PATH)
      return ok('ok')
    },
    vault: async (_args, caller) => {
      await ext.openPanel(caller.workspaceId, VAULT_PATH)
      return ok('ok')
    },
    init: async (_args, caller) => initHere(deps, caller),
    card: async (args, caller) => {
      const t = translate(caller.locale)
      const raw = cliArgs(args)?.argv[0]
      if (!raw) return failure('missing-ref', t('cardUsage'))
      const ref = cardRef(raw)
      const path = ref ? cardPath(ref) : null
      if (!ref || !path) return failure('invalid-ref', t('invalidRef', { raw }))
      if (!(await service.isInstalled())) return failure('not-installed', t('notInstalled'))
      await ext.openPanel(caller.workspaceId, path)
      return ok(t('cardOpened', { ref }), { ref, path })
    },
    status: async (_args, caller) => {
      const t = translate(caller.locale)
      if (!(await service.isInstalled())) return failure('not-installed', t('notInstalled'))
      const project = service.projectFor(caller.workDir)
      if (!project) return ok(t('noProject'), null)
      const counts = await service.counts(project)
      if (!counts) return failure('trellis-failed', t('statusFailed'))
      const data = { project: project.project, board: project.board ?? null, ...counts }
      return ok(`${project.project}: ${service.chipTooltip(counts, t)}`, data)
    },
    'session-context': async (_args, caller) =>
      ok(sessionContext(service.projectFor(caller.cwd ?? caller.workDir))),
  }

  ext.onPanel((caller, path) => {
    const target = panelTarget(path)
    const query: Record<string, string> = {
      workDir: caller.workDir ?? '',
      workspaceId: caller.workspaceId ?? '',
      locale: caller.locale ?? 'en',
      view: target.view,
    }
    if (target.card) query.card = target.card
    return { url: panel.url(query) }
  })

  await ext.registerCommands(handlers)

  const onEvent: EventHandler = (type, payload) => {
    if (type === 'pane.closed' && tasks.dropPane((payload as { paneId: string }).paneId)) {
      service.changed()
    }
    service.scheduleRefresh()
  }
  const withFocus = (await ext.subscribe([...EVENTS, FOCUS_EVENT], onEvent)) as { ok?: boolean }
  if (withFocus?.ok === false) await ext.subscribe(EVENTS, onEvent)
  let refresh: ReturnType<typeof setInterval> | null = null
  const applySettings = (values: ExtensionSettingValues): void => {
    service.notifyKinds = {
      review: booleanSetting(values, 'notifyReview', true),
      blocked: booleanSetting(values, 'notifyBlocked', true),
    }
    const seconds = numberSetting(values, 'refreshSeconds', 60, REFRESH_SECONDS)
    if (refresh) clearInterval(refresh)
    refresh = setInterval(() => void service.refreshSidebar(), seconds * 1000)
    refresh.unref()
  }
  ext.onSettingsChanged(applySettings)
  applySettings(await ext.getSettings())

  await service.refreshSidebar()
  void service.startEvents()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
