import { createArtifactServices } from '../artifacts/artifactServices'
import { OpenWaits } from '../files/openWaits'
import { createLanguageServerWiring } from '../lsp/languageServerWiring'
import { readSettingsFile } from '../platform/settingsFile'
import { createSandboxServices } from '../sandbox/sandboxServices'
import { createSecretServices } from '../secrets/secretServices'
import type { SharedContext } from './sharedServices'

export function createConfinedServices(ctx: SharedContext) {
  const {
    broadcast,
    keepShellsOn,
    keptShells,
    keptShellsProgram,
    paneLauncherDir,
    ptys,
    services,
    windows,
  } = ctx

  const {
    scratchFolders,
    artifactFolders,
    fileRoots,
    openFileGrants,
    previews,
    portableExport,
    artifactHistory,
    artifactProducers,
    artifactsChanged,
    isScratchPane,
  } = createArtifactServices({ windows, workspaceSandboxes: () => workspaceSandboxes, services })

  const openWaits = new OpenWaits((windowId, paneIds) =>
    windows.get(windowId)?.webContents.send('open-waits:ended', paneIds),
  )

  const {
    workspaceSandboxes,
    keptHostPanes,
    syncKeptExposed,
    sandboxViolations,
    sandboxCanRead,
    phoneFileScope,
    paneForWorkspace,
    domainRequests,
    portForwarder,
    packageRequests,
    portRequests,
    hostPaneGrants,
    scanSandboxPorts,
  } = createSandboxServices({
    ptys,
    keptShells,
    readSettingsFile,
    paneLauncherDir,
    keepShellsOn,
    keptShellsProgram,
  })

  const {
    editorLanguageOf,
    managedServers,
    languageServerWatches,
    serverOverrides,
    createLanguageServers,
  } = createLanguageServerWiring({
    contributions: () => services.extensionHost?.contributions ?? null,
    fileRoots,
    openFileGrants,
    workspaceSandboxes,
    sandboxCanRead,
    windows,
    broadcast,
    appLog: () => services.appLog,
  })

  const { secretService, workspaceAgents, injectSecrets } = createSecretServices({
    workspaceSandboxes,
    paneForWorkspace,
  })

  return {
    scratchFolders,
    artifactFolders,
    fileRoots,
    openFileGrants,
    previews,
    portableExport,
    artifactHistory,
    artifactProducers,
    artifactsChanged,
    isScratchPane,
    openWaits,
    workspaceSandboxes,
    keptHostPanes,
    syncKeptExposed,
    sandboxViolations,
    phoneFileScope,
    domainRequests,
    portForwarder,
    packageRequests,
    portRequests,
    hostPaneGrants,
    scanSandboxPorts,
    editorLanguageOf,
    managedServers,
    languageServerWatches,
    serverOverrides,
    createLanguageServers,
    secretService,
    workspaceAgents,
    injectSecrets,
  }
}

export type ConfinedContext = SharedContext & ReturnType<typeof createConfinedServices>
