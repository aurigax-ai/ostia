import { basename, join } from 'node:path'
import {
  type EventHandler,
  connect,
  createTranslator,
  failure,
  ok,
  onShutdown,
} from '@aurigax-ai/ostia-extension-sdk'
import { CreateGate } from './createGate'
import { DomainCards } from './domainCards'
import { installState } from './install'
import { type PanelScopeWithSandbox, panelHandlers } from './panelApi'
import { startPanelServer } from './panelServer'
import { PhoneLinks } from './phoneLinks'
import { SCREENS_BIN, createLeased, isOnPath, serviceVersion } from './screensCli'
import { ScreensService } from './screensService'
import { verbHandlers } from './verbs'
import { Viewers, viewStream } from './viewers'

const PANEL_FILES = ['panel.html', 'panel.js', 'panel.css', 'base.css']
const VIEWER_FOLDER = 'novnc'

async function main(): Promise<void> {
  const ext = await connect()
  const translate = createTranslator()
  const workspaceName = async (workspaceId: string): Promise<string> => {
    const found = (await ext.listWorkspaces().catch(() => [])).find(
      (w) => w.workspaceId === workspaceId,
    )
    return found?.name || (found?.workDir ? basename(found.workDir) : workspaceId)
  }
  let panelChanged = (): void => {}
  const viewers = new Viewers()
  let locale = await ext.getLocale()
  ext.onLocaleChanged((next) => {
    locale = next
  })
  const domainCards = new DomainCards({
    confirm: (req) => ext.confirm(req),
    translate,
    locale: () => locale,
    workspaceName: (workspaceId) => workspaceName(workspaceId),
  })
  const service = new ScreensService({
    created: (screen) => {
      domainCards.watch(screen)
      panelChanged()
    },
    stopped: (screen) => {
      domainCards.unwatch(screen.id)
      viewers.closeScreen(screen.id)
      panelChanged()
    },
  })
  onShutdown(() => {
    viewers.closeAll()
    service.stopAllNow()
  })

  const sandboxedPanels = new Map<string, boolean>()
  const gate = new CreateGate({
    confirm: (req) => ext.confirm(req),
    card: (name, locale) => {
      const t = translate(locale)
      return {
        title: t('create.title'),
        message: t('create.message', { workspace: name }),
        detail: t('create.detail'),
        confirmLabel: t('create.always'),
        cancelLabel: t('create.deny'),
      }
    },
  })
  const sandboxDomains = (workspaceId: string) => ext.sandboxDomains(workspaceId)

  const showPhone = (workspaceId: string): void => {
    void ext
      .setSidebarItem({
        key: 'phone',
        workspaceId,
        text: phoneLinks.hasLink(workspaceId) ? translate(locale)('sidebar.phone') : '',
        badge: 'phone',
      })
      .catch(() => {})
  }
  const phoneLinks = new PhoneLinks({
    phone: ext.phoneScreens,
    service,
    version: serviceVersion,
    lease: createLeased,
    changed: (workspaceId) => {
      showPhone(workspaceId)
      panelChanged()
    },
    now: () => Date.now(),
  })
  const listening = await ext.phoneScreens.listen(phoneLinks.controller())

  const panelOnly = panelHandlers({
    service,
    gate,
    translate,
    installState: (reason) => installState(reason),
    confirm: (req) => ext.confirm(req),
    openTerminal: (opts) => ext.openTerminal(opts),
    sandboxDomains,
    viewers,
    phones: () => (listening.ok ? phoneLinks : null),
    now: () => Date.now(),
  })
  const panel = await startPanelServer({
    dir: __dirname,
    files: PANEL_FILES,
    vendor: { dir: join(__dirname, VIEWER_FOLDER), prefix: `${VIEWER_FOLDER}/` },
    openStream: viewStream(service, viewers),
    handle: async (command, args, scope) => {
      const handler = panelOnly[command]
      const full: PanelScopeWithSandbox = {
        ...scope,
        sandboxed: sandboxedPanels.get(scope.workspaceId) === true,
      }
      return handler ? handler(args, full) : failure('unknown-command', command)
    },
  })
  panelChanged = () => panel.changed()

  ext.onPanel((caller) => {
    const workspaceId = caller.workspaceId ?? ''
    sandboxedPanels.set(workspaceId, caller.sandboxed === true)
    return { url: panel.open({ workspaceId, locale: caller.locale ?? 'en' }) }
  })

  await ext.registerCommands({
    open: async (_args, caller) => {
      await ext.openPanel(caller.workspaceId)
      return ok('ok')
    },
    ...verbHandlers({
      service,
      gate,
      translate,
      installed: () => isOnPath(SCREENS_BIN),
      sandboxDomains,
      workspaceName,
    }),
  })

  const onEvent: EventHandler = (type, payload) => {
    if (type !== 'workspace.closed') return
    const { workspaceId } = payload as { workspaceId: string }
    gate.revoke(workspaceId)
    panel.forget(workspaceId)
    sandboxedPanels.delete(workspaceId)
    void service.stopWorkspace(workspaceId)
  }
  await ext.subscribe(['workspace.closed'], onEvent)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
