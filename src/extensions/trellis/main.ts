import { homedir } from 'node:os'
import {
  type CommandHandler,
  type ExtensionCaller,
  type ExtensionEventType,
  type ExtensionSettingValues,
  PRODUCT_NAME,
  booleanSetting,
  cliArgs,
  connect,
  failure,
  numberSetting,
  ok,
  onShutdown,
  startMessageServer,
} from '@aurigax-ai/pine-extension-sdk'
import { type AuthProxy, type ProxyUpstream, startAuthProxy } from './proxy'
import { TrellisService, TrellisUnavailable, type WorkspaceRef } from './service'
import { cardPath, cardRef, isAppPath, loopbackHttpUrl, projectPath } from './trellis'

const REFRESH_SECONDS = { min: 10, max: 3600 }
const EVENTS: ExtensionEventType[] = ['pane.created', 'pane.closed', 'cwd.changed']
const FOCUS_EVENT = 'focus.changed' as ExtensionEventType

function workspacesFrom(raw: unknown): WorkspaceRef[] {
  if (!Array.isArray(raw)) throw new Error('workspace.list returned no list')
  return raw
    .filter(
      (s): s is { workspaceId: string; workDir: string } =>
        typeof s?.workspaceId === 'string' && typeof s?.workDir === 'string',
    )
    .map((s) => ({ workspaceId: s.workspaceId, workDir: s.workDir }))
}

function upstreamOf(uiUrl: string | null): ProxyUpstream | null {
  const url = loopbackHttpUrl(uiUrl)
  if (!url) return null
  const headers: Record<string, string> = {}
  const token = url.searchParams.get('token')
  if (token) headers['x-trellis-token'] = token
  return { origin: url.origin, headers }
}

async function main(): Promise<void> {
  const ext = await connect()
  const service = new TrellisService({
    home: homedir(),
    consumer: PRODUCT_NAME,
    host: {
      listWorkspaces: async () => workspacesFrom(await ext.call('workspace.list')),
      setWorkspaceChip: (chip) => ext.setWorkspaceChip(chip),
      clearWorkspaceChip: (workspaceId, id) => ext.clearWorkspaceChip(workspaceId, id),
      notifyPanel: (title, body, path) => ext.notifyPanel(title, body, path),
      log: (line) => console.error(line),
    },
  })
  onShutdown(() => service.stop())

  let uiUrl: string | null = null
  let proxy: AuthProxy | null = null
  const messages = await startMessageServer()
  const ensureProxy = async (): Promise<AuthProxy> => {
    proxy ??= await startAuthProxy({ upstream: () => upstreamOf(uiUrl), isAllowedEntry: isAppPath })
    return proxy
  }

  const remember = (caller: ExtensionCaller): void => {
    if (caller.locale) service.locale = caller.locale
  }

  const unavailableText = (err: unknown): string =>
    err instanceof TrellisUnavailable ? err.message : service.strings.uiFailed

  const handlers: Record<string, CommandHandler> = {
    open: async (_args, caller) => {
      remember(caller)
      try {
        uiUrl = await service.ensureUi()
      } catch (err) {
        return failure(
          err instanceof TrellisUnavailable ? err.code : 'ui-failed',
          unavailableText(err),
        )
      }
      await ext.openPanel(caller.workspaceId)
      return ok('ok')
    },
    init: async (_args, caller) => {
      remember(caller)
      const dir = caller.cwd ?? caller.workDir
      if (!dir) return failure('no-dir', service.strings.noDir)
      if (!(await service.isInstalled())) {
        return failure('not-installed', service.strings.notInstalled)
      }
      const s = service.strings
      const confirmed = await ext.confirm({
        title: s.initTitle,
        message: s.initMessage(dir),
        detail: s.initDetail,
        confirmLabel: s.initConfirm,
        cancelLabel: s.cancel,
      })
      if (!confirmed) return ok(s.initCancelled)
      const res = await service.init(dir)
      return res.ok ? ok(res.text) : failure('init-failed', res.message)
    },
    card: async (args, caller) => {
      remember(caller)
      const raw = cliArgs(args)?.argv[0]
      if (!raw) return failure('missing-ref', service.strings.cardUsage)
      const ref = cardRef(raw)
      const path = ref ? cardPath(ref) : null
      if (!ref || !path) return failure('invalid-ref', service.strings.invalidRef(raw))
      try {
        uiUrl = await service.ensureUi()
      } catch (err) {
        return failure(
          err instanceof TrellisUnavailable ? err.code : 'ui-failed',
          unavailableText(err),
        )
      }
      await ext.openPanel(caller.workspaceId, path)
      return ok(service.strings.cardOpened(ref), { ref, path })
    },
    status: async (_args, caller) => {
      remember(caller)
      if (!(await service.isInstalled())) {
        return failure('not-installed', service.strings.notInstalled)
      }
      const project = service.projectFor(caller.workDir)
      if (!project) return ok('no trellis project', null)
      const counts = await service.counts(project)
      if (!counts) return failure('trellis-failed', service.strings.uiFailed)
      const data = { project: project.project, board: project.board ?? null, ...counts }
      return ok(`${project.project}: ${service.strings.sidebar(counts)}`, data)
    },
  }

  ext.onPanel(async (caller, path) => {
    remember(caller)
    try {
      uiUrl = await service.ensureUi()
      const p = await ensureProxy()
      const entry = path && isAppPath(path) ? path : projectPath(service.projectFor(caller.workDir))
      return { url: p.entryUrl(entry) }
    } catch (err) {
      return { url: messages.url(service.strings.unavailableTitle, unavailableText(err)) }
    }
  })

  await ext.registerCommands(handlers)

  const onEvent = (): void => service.scheduleRefresh()
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
