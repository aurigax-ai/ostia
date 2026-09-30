import type { ExtensionEventType } from '../../shared/extensions'
import {
  type CommandHandler,
  type ExtensionCaller,
  type ExtensionSettingValues,
  booleanSetting,
  connect,
  failure,
  numberSetting,
  ok,
  onShutdown,
  startMessageServer,
} from '../sdk'
import { APPROVALS_PATH, FAST_POLL_MS, IDLE_POLL_MS, formatQueue } from './keeper'
import { KeeperService } from './service'

const FOCUS_EVENT = 'focus.changed' as ExtensionEventType
const FAST_SECONDS = { min: 2, max: 300 }
const IDLE_SECONDS = { min: 10, max: 3600 }

function serviceSettings(values: ExtensionSettingValues) {
  return {
    intervals: {
      fastMs: numberSetting(values, 'pollSeconds', FAST_POLL_MS / 1000, FAST_SECONDS) * 1000,
      idleMs: numberSetting(values, 'idlePollSeconds', IDLE_POLL_MS / 1000, IDLE_SECONDS) * 1000,
    },
    notify: booleanSetting(values, 'notify', true),
  }
}

async function main(): Promise<void> {
  const ext = await connect()
  const service = new KeeperService({
    host: {
      setSidebarItem: (item) => ext.setSidebarItem(item),
      notifyPanel: (title, body, path) => ext.notifyPanel(title, body, path),
      log: (line) => console.error(line),
    },
  })
  onShutdown(() => service.stop())
  ext.onSettingsChanged((values) => service.configure(serviceSettings(values)))
  service.configure(serviceSettings(await ext.getSettings()))
  const messages = await startMessageServer()

  const remember = (caller: ExtensionCaller): void => {
    if (caller.locale) service.locale = caller.locale
  }

  const openPanel = async (caller: ExtensionCaller, path: string) => {
    if (!(await service.daemonRunning())) {
      return failure(service.state, service.unavailableMessage())
    }
    await ext.openPanel(caller.workspaceId, path)
    return ok('ok')
  }

  const handlers: Record<string, CommandHandler> = {
    open: async (_args, caller) => {
      remember(caller)
      return openPanel(caller, '/')
    },
    approvals: async (_args, caller) => {
      remember(caller)
      await service.tick()
      if (service.state !== 'ready') {
        return failure(service.state, service.unavailableMessage())
      }
      const list = service.approvals()
      const text = formatQueue(list, Date.now(), service.strings.empty)
      if (caller.kind === 'user') await openPanel(caller, APPROVALS_PATH)
      return ok(text, list)
    },
  }

  ext.onPanel(async (caller, requested) => {
    remember(caller)
    const base = await service.uiUrl()
    const path = requested ?? (service.approvals().length > 0 ? APPROVALS_PATH : '/')
    if (base) return { url: `${base}${path}` }
    const s = service.strings
    const body = service.state === 'ready' ? s.noUi : service.unavailableMessage()
    return { url: messages.url(s.unavailableTitle, body) }
  })

  await ext.registerCommands(handlers)
  const focus = (await ext.subscribe([FOCUS_EVENT], (type, payload) => {
    if (type === FOCUS_EVENT)
      service.setFocused((payload as { focused?: boolean }).focused === true)
  })) as { ok?: boolean }
  if (focus?.ok === false) console.error('focus events unavailable; polling at the idle rate')
  await service.tick()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
