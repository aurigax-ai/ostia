import { app } from 'electron'
import type { CommandTarget } from '../../shared/control/commands'
import { createAgentOfferRelay } from '../agents/agentOfferRelay'
import { getByPaneId } from '../control/idRegistry'
import { createExtensionIpc } from '../extensions/extensionWiring'
import { createMarketplaceIpc } from '../extensions/marketplace/marketplaceIpc'
import { createCoreBoards } from '../git/coreBoards'
import { createManagerPanes } from '../manager/managerPanes'
import { createSessionAttacher } from '../manager/managerSession'
import { createEncryptedStores } from '../secrets/encryptedStores'
import { isHiddenLaunch } from '../windows/tray'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import type { WindowShellContext } from './windowShell'

export function createFeatureServices(ctx: WindowShellContext) {
  const {
    attachMirror,
    configDir,
    editorLanguageOf,
    execCommand,
    getTerminalState,
    isWaking,
    mainStrings,
    officialMarketplaceId,
    openFileGrants,
    openTerminalInWindow,
    primaryWindowId,
    ptyPid,
    ptys,
    reach,
    remoteCwdOfPane,
    revealApp,
    sendToWindow,
    sendToWorkspaceWindow,
    services,
    terminalState,
    windowIds,
    windows,
    workspaceWindowId,
  } = ctx

  const {
    extensionConnections,
    extensionSecretStore,
    assistKeyStore,
    encryptedFile,
    encryptedStore,
  } = createEncryptedStores()

  const { registerMarketplaceIpc } = createMarketplaceIpc({
    openFileGrants,
    services,
    officialMarketplaceId,
    editorLanguageOf,
  })

  const { refreshAgentPlugins, extensionRoots, registerExtensionIpc, registerRemoteFilesIpc } =
    createExtensionIpc({ services, configDir, workspaceWindowId, terminalState, remoteCwdOfPane })

  const { startCoreBoards } = createCoreBoards({
    execCommand,
    getTerminalState,
    ptyPid,
    windowIds,
    isWaking,
    sendToWindow,
    services,
    mainStrings,
    sendToWorkspaceWindow,
    windows,
    terminalState,
    workspaceWindowId,
  })

  const agentOffers = createAgentOfferRelay({
    windowOf: (workspaceId) => workspaceWindowId(workspaceId),
    send: (windowId, channel, payload) => {
      const win = windows.get(windowId)
      if (!win || win.isDestroyed()) return false
      win.webContents.send(channel, payload)
      return true
    },
    externalIdOf: (paneId) => getByPaneId(paneId)?.externalId,
  })

  const { registerManagerIpc, createManagerPane, openWorker, startPortal } = createManagerPanes({
    primaryWindowId,
    windows,
    reach,
    execCommand,
    openTerminalInWindow,
    services,
    ptys,
    attachMirror,
    attachSession: createSessionAttacher({
      sessions: () => services.agentSessions,
      manager: () => services.managerService,
    }),
  })

  app.on('second-instance', (_event, argv) => {
    if (!app.isReady() || isHiddenLaunch(argv)) return
    revealApp()
  })

  const workspaceCommandTarget = (workspaceId: string): CommandTarget => ({
    windowId: windowForWorkspace(workspaceId) ?? '',
    workspaceId,
    paneId: null,
  })

  return {
    extensionConnections,
    extensionSecretStore,
    assistKeyStore,
    encryptedFile,
    encryptedStore,
    registerMarketplaceIpc,
    refreshAgentPlugins,
    extensionRoots,
    registerExtensionIpc,
    registerRemoteFilesIpc,
    startCoreBoards,
    agentOffers,
    registerManagerIpc,
    createManagerPane,
    openWorker,
    startPortal,
    workspaceCommandTarget,
  }
}

export type FeatureContext = WindowShellContext & ReturnType<typeof createFeatureServices>
