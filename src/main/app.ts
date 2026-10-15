import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ExtensionEventPayloads,
  ExtensionEventType,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { OFFICIAL_MARKETPLACE } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import {
  type RemoteCwd,
  normalizeRemoteCwd,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import { ChangeSignal } from '../shared/common/actThenConfirm'
import { externalHref } from '../shared/common/externalLinks'
import type { CommandDescriptor, CommandTarget, TerminalStateSnapshot } from '../shared/types'
import { createAgentOfferRelay } from './agents/agentOfferRelay'
import { AgentRunningPanes } from './agents/agentRunning'
import { registerAgentTranscriptIpc } from './agents/agentTranscript'
import { registerAgentWiring } from './agents/agentWiring'
import { ReportedAgentWork } from './agents/agentWork'
import { registerFolderTrustIpc } from './agents/folderTrustIpc'
import type { OriginReach } from './agents/originAgents'
import { createResumeClaimer, registerResumeClaimIpc } from './agents/resumeClaims'
import { registerToolbeltWiring } from './agents/toolbeltWiring'
import { approvals } from './approvals/approvals'
import { registerApprovalsWiring } from './approvals/approvalsWiring'
import { createAskHub } from './approvals/asks'
import { loadReachMode, refreshCapabilitySettings } from './approvals/capabilityStore'
import { questions } from './approvals/questions'
import { type ReachListing, createReach } from './approvals/reach'
import { createScriptTokenUsage } from './approvals/scriptTokenUsage'
import {
  listScriptTokens,
  recordCreatedWorkspace,
  scriptTokenScope,
} from './approvals/scriptTokens'
import { createArtifactServices } from './artifacts/artifactServices'
import { registerArtifactViewIpc, startArtifacts } from './artifacts/artifactWiring'
import { targetOf } from './attention/attention'
import { registerNotifyWiring } from './attention/notifyWiring'
import type { ConsoleEntry } from './browser/browseMethod'
import { registerBrowserGuestIpc } from './browser/browserGuestIpc'
import { createBrowserGuests } from './browser/browserGuests'
import { registerBrowserWiring } from './browser/browserWiring'
import type { GuestChords } from './browser/guestChords'
import { createGuestProfiles } from './browser/guestProfiles'
import { startChat } from './chat/chatWiring'
import type { McpHost } from './chat/mcpHost'
import type { McpOAuth } from './chat/mcpOAuth'
import { createCommandBridge } from './control/commandBridge'
import { setCapFilter } from './control/controlAuth'
import { startControlServer } from './control/controlWiring'
import { emitPlatformEvent } from './control/events'
import {
  type PaneIdentity,
  getByPaneId,
  resolveExternal,
  setPaneIdSalt,
  workspaceHasManager,
} from './control/idRegistry'
import { loadPaneIdSalt } from './control/paneIdSalt'
import { type AppLog, LOG_FILE_NAME, createAppLog } from './diagnostics/appLog'
import { type Diagnostics, registerDiagnostics } from './diagnostics/diagnostics'
import { createSessionFacts } from './diagnostics/sessionFacts'
import { TELEMETRY_FILE, type Telemetry, registerTelemetry } from './diagnostics/telemetry'
import type { ExtensionHost } from './extensions/extensionHost'
import {
  createExtensionIpc,
  extensionHostParts,
  startExtensionHost,
} from './extensions/extensionWiring'
import { marketplaceId, normalizeMarketplaceUrl } from './extensions/marketplace/marketplace'
import { createMarketplaceIpc } from './extensions/marketplace/marketplaceIpc'
import { startMarketplace } from './extensions/marketplace/marketplaceWiring'
import { PaneAttentionEvents } from './extensions/paneAttentionEvents'
import { createMainStrings } from './extensions/strings'
import type { FileWatches } from './files/fileWatch'
import { registerFsIpc } from './files/fsIpc'
import { OpenWaits } from './files/openWaits'
import { startGateway } from './gateway/gatewayWiring'
import { createCoreBoards } from './git/coreBoards'
import type { GitService } from './git/service'
import { createLanguageServerWiring } from './lsp/languageServerWiring'
import type { LanguageServers } from './lsp/languageServers'
import type { ManagerService } from './manager/manager'
import type { ManagerLimiter } from './manager/managerMethods'
import { createManagerPanes } from './manager/managerPanes'
import { createManagerPty } from './manager/managerPty'
import { startManager } from './manager/managerWiring'
import type { Portal } from './manager/portal'
import { registerPaneLifecycleIpc } from './panes/paneLifecycleIpc'
import { listPanes, listWorkspaceGroups, listWorkspaces } from './panes/paneList'
import { registerPaneMethodsWiring } from './panes/paneMethodsWiring'
import { PaneWatch } from './panes/paneWait'
import { PaneWaking } from './panes/paneWaking'
import type { ProcessRegistry } from './panes/processRegistry'
import { storePath } from './platform/jsonStore'
import { managerSettings, readLocale, readSettingsFile } from './platform/settingsFile'
import { resolveLoginPath } from './platform/toolPath'
import { appConfigDir } from './platform/userDirs'
import type { PortsService } from './ports/service'
import { registerPrivacyIpc } from './privacy/privacyIpc'
import { createRedactor } from './privacy/redaction'
import { createWorkerScan, redactionWorkerScript } from './privacy/redactionScan'
import type { ProfileSyncHandle } from './profileSync/ipc'
import { startProfileSyncWiring } from './profileSync/profileSyncWiring'
import { createSandboxServices } from './sandbox/sandboxServices'
import { registerSandboxIpcWiring, registerSandboxWiring } from './sandbox/sandboxWiring'
import { createEncryptedStores } from './secrets/encryptedStores'
import { createSecretServices } from './secrets/secretServices'
import { registerPtyIpc } from './terminal/pty/ptyIpc'
import type { PtyEntry } from './terminal/pty/ptyRegistry'
import { createPtyWiring } from './terminal/pty/ptyWiring'
import { registerSelectionIpc } from './terminal/selectionReport'
import type { SavedAttention } from './tmux/attentionFile'
import { KeptAttention } from './tmux/keptAttention'
import { createKeptShellsWiring, startKeptShells } from './tmux/keptShellsWiring'
import { appVersion, runningBuild } from './updates/appVersion'
import type { PendingSweep } from './updates/installReplace'
import { signaturePolicy } from './updates/macReplace'
import type { UpdateRunner } from './updates/updateRun'
import { startUpdates } from './updates/updateWiring'
import { installAppMenu } from './windows/appMenu'
import { registerAppQuit } from './windows/appQuit'
import { createAppWindows } from './windows/appWindows'
import type { ClipboardEdits } from './windows/clipboardEdits'
import type { GlobalHotkey } from './windows/globalHotkey'
import { createQuitTrace } from './windows/quitPlan'
import { createQuitTeardown } from './windows/quitTeardown'
import { type AppTray, isHiddenLaunch } from './windows/tray'
import type { WindowBroker } from './windows/windowBroker'
import { registerWindowInputGuards, registerWindowIpc } from './windows/windowIpc'
import { createWindowSend } from './windows/windowSend'
import { startWindows } from './windows/windowStartup'
import { createWindowWiring } from './windows/windowWiring'
import { registerContentIpc } from './workspaces/contentWiring'
import { createScrollbackPersistence } from './workspaces/scrollbackPersistence'
import type { ViewHost } from './workspaces/viewHost'
import { createWorkspaceLifecycle } from './workspaces/workspaceLifecycle'
import { windowForWorkspace, workDirForWorkspace } from './workspaces/workspaceRegistry'
import {
  type RestoreOutcome,
  loadRestoredScrollback,
  pendingRestoredScrollback,
} from './workspaces/workspaceSnapshot'

const windows = new Map<string, BrowserWindow>()
const commandsByWindow = new Map<string, CommandDescriptor[]>()

const browserPanes = new Map<string, number>()

const consoleBuffers = new Map<number, ConsoleEntry[]>()
const errorBuffers = new Map<number, ConsoleEntry[]>()

const terminalState = new Map<string, TerminalStateSnapshot>()

const ptys = new Map<string, PtyEntry>()

const quit = {
  restartRequested: false,
  stagedUpdate: null as { pending: PendingSweep; sweepFile: string } | null,
  quitApproved: false,
  scrollbackSavedForQuit: false,
  savingScrollbackForQuit: false,
}

const services = {
  appLog: null as AppLog | null,
  diagnostics: null as Diagnostics | null,
  telemetry: null as Telemetry | null,
  restoreOutcome: 'none' as RestoreOutcome,
  marketplaceInstallIds: (): string[] => [],
  processes: null as ProcessRegistry | null,
  updateRunner: null as UpdateRunner | null,
  languageServers: null as LanguageServers | null,
  onSandboxSpawnFailure: null as ((workspaceId: string, errors: string[]) => void) | null,
  extensionHost: null as ExtensionHost | null,
  gitService: null as GitService | null,
  portsService: null as PortsService | null,
  viewHost: null as ViewHost | null,
  mcpHost: null as McpHost | null,
  mcpOAuth: null as McpOAuth | null,
  broker: null as WindowBroker | null,
  profileSync: null as ProfileSyncHandle | null,
  stopTailnet: null as (() => Promise<void>) | null,
  stopAnnouncing: null as (() => void) | null,
  clipboardEdits: null as ClipboardEdits | null,
  guestChords: null as GuestChords | null,
  appTray: null as AppTray | null,
  globalHotkey: null as GlobalHotkey | null,
  releaseChecks: null as { settingsChanged: () => void } | null,
  managerService: null as ManagerService | null,
  managerLimiter: null as ManagerLimiter | null,
  portal: null as Portal | null,
  fileWatches: null as FileWatches | null,
}

const {
  settingsChanged,
  windowIds,
  workspaceWindowId,
  publishRemoteFolders,
  sendToWorkspaceWindow,
  broadcast,
  publishWorkspaceChips,
  focusPaneInWindow,
  primaryWindowId,
  showWindow,
  mainWindow,
  sendToWindow,
} = createWindowSend({ windows, services })

const { listCommandsFor, getTerminalState, execCommand, openTerminalInWindow } =
  createCommandBridge({ commandsByWindow, terminalState, windows, mainWindow, workspaceWindowId })

const hibernatedPanes = new Set<string>()
const movingPanes = new Set<string>()
const recoveryHeld = new Set<string>()
const closedPanes = new Set<string>()

const telemetrySessionFacts = createSessionFacts({
  readSettings: readSettingsFile,
  installedExtensions: () => services.marketplaceInstallIds(),
  extensions: () => services.extensionHost?.list() ?? [],
  windows,
  workspacesOf: (win) => services.broker?.workspacesOf(win).length ?? 0,
  restoreOutcome: () => services.restoreOutcome,
})

const officialMarketplaceId = marketplaceId(normalizeMarketplaceUrl(OFFICIAL_MARKETPLACE) ?? '')

function openExternalSafe(url: string): boolean {
  const href = externalHref(url, { apps: false })
  if (!href) return false
  void shell.openExternal(href)
  return true
}

const {
  keptShells,
  keepShellsOn,
  keptShellsProgram,
  savedPaneIds,
  withKeptProcess,
  syncKeptMeta,
  paneLauncherDir,
  keptPlumbing,
  keptPaneEnv,
} = createKeptShellsWiring({
  ptys,
  readSettingsFile,
  processes: () => services.processes,
  appLog: () => services.appLog,
})
const updatePolicy = signaturePolicy(app.isPackaged, process.env)
const UPDATE_HOST_GRANT_ID = 'core:update'

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
} = createArtifactServices({ windows, workspaceSandboxes: () => workspaceSandboxes })

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

const PORT_SCAN_MS = 3000

const { secretService, workspaceAgents, injectSecrets } = createSecretServices({
  workspaceSandboxes,
  paneForWorkspace,
})

const { browserProfiles, browserFence, fenceBrowserGuest } = createGuestProfiles({
  scratchFolders,
  workspaceSandboxes,
  domainRequests,
  browserPanes,
})

const {
  extensionOfPartition,
  browserAgentsOf,
  instrumentBrowserGuest,
  allowHumanPopups,
  hardenExtensionGuest,
} = createBrowserGuests({
  contextMenuText: () => mainStrings().native.contextMenu,
  consoleBuffers,
  errorBuffers,
  windows,
  services,
  openExternalSafe,
})

setCapFilter((conn, cap) => {
  if (cap !== 'all-workspaces') return true
  const workspaceId = resolveExternal(conn.externalId)?.workspaceId || conn.workspaceId
  if (!workspaceId || !workspaceSandboxes.isEnabled(workspaceId)) return true
  return workspaceSandboxes.resolved(workspaceId).controls.allWorkspaces
})

async function workspaceListing(): Promise<ReachListing> {
  const [workspaces, groups] = await Promise.all([
    listWorkspaces({ execCommand, windowIds }),
    listWorkspaceGroups({ execCommand, windowIds }),
  ])
  return { workspaces, groups }
}

const reach = createReach({
  mode: loadReachMode,
  home: homedir(),
  workDir: (workspaceId) => workDirForWorkspace(workspaceId),
  isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
  hasManager: (workspaceId) => workspaceHasManager(workspaceId),
  sandbox: (workspaceId) => ({
    ...workspaceSandboxes.settings(workspaceId),
    enabled: workspaceSandboxes.isEnabled(workspaceId),
  }),
  workspaces: workspaceListing,
  ask: (ask) => approvals()?.request(ask) ?? null,
  agentGroupsChanged: (placements) => broadcast('reach:agent-groups-changed', placements),
  scriptScope: (tokenId) => scriptTokenScope(scriptTokensPath(), tokenId),
  scriptCreated: (tokenId, workspaceId) =>
    recordCreatedWorkspace(scriptTokensPath(), tokenId, workspaceId),
})
ipcMain.handle('reach:agent-groups', () => reach.agentGroups())

const { workspaceClosed, releaseMergedSandbox, registerWorkspaceIpc } = createWorkspaceLifecycle({
  openWaits,
  reach,
  services,
  artifactHistory,
  artifactFolders,
  scratchFolders,
  packageRequests,
  portForwarder,
  portRequests,
  domainRequests,
  workspaceSandboxes,
  sandboxViolations,
  workspaceAgents,
  secretService,
  ptys,
  emitPaneEvent,
  artifactProducers,
})

function emitPaneEvent<T extends ExtensionEventType>(
  type: T,
  payload: ExtensionEventPayloads[T],
): void {
  services.extensionHost?.events.emitEvent(type, payload)
  services.gitService?.activity(type)
  services.portsService?.activity(type)
}
const agentChanges = new ChangeSignal()
const startedAgents = new Set<string>()
const agentRunning = new AgentRunningPanes(() => {
  services.broker?.persist()
  agentChanges.fire()
})
const agentWork = new ReportedAgentWork()

const askHub = createAskHub({
  text: () => mainStrings().approvals,
  questions,
  approvals,
  identity: getByPaneId,
  created: (ask) => emitPlatformEvent('ask.created', { ask }),
  resolved: (resolved) => emitPlatformEvent('ask.resolved', resolved),
})
const keptAttention = new KeptAttention()

function restoreKeptAttention(identity: PaneIdentity, saved: SavedAttention): void {
  void execCommand(targetOf(identity), 'attention.set', saved).then((res) => {
    if (res.ok) keptAttention.reported(identity.paneId)
  })
}
const paneWatch = new PaneWatch()
const paneAttentionEvents = new PaneAttentionEvents({
  identity: getByPaneId,
  emit: (payload) => emitPaneEvent('pane.attention', payload),
})
const paneWaking = new PaneWaking()
const isWaking = (paneId: string): boolean => paneWaking.has(paneId)
const reachesPane: OriginReach = (senderWindowId, sourcePaneId, targetPaneId) =>
  services.broker?.reaches(senderWindowId, sourcePaneId, targetPaneId) ?? false

const {
  loadPty,
  feedPty,
  trackPty,
  killPty,
  hibernatePty,
  paneActivity,
  foregroundProgram,
  agentCwd,
  sandboxReadRules,
  ptyPid,
  paneOutput,
  paneIo,
  releasePtyFlow,
  hidePtyFlow,
  attachMirror,
  ptyResize,
  ptyWrite,
  attachPhoneObserver,
  windowOfPane,
  startRecovery,
  finishRecovery,
  releaseWindowPtys,
  holdPtys,
  releaseMovingPane,
  attachPty,
} = createPtyWiring({
  ptys,
  movingPanes,
  recoveryHeld,
  closedPanes,
  openWaits,
  agentRunning,
  agentWork,
  keptAttention,
  services,
  hibernatedPanes,
  startedAgents,
  terminalState,
  keptShells,
  paneWaking,
  workspaceSandboxes,
  injectSecrets,
  keptPlumbing,
  portRequests,
  releaseMergedSandbox,
  restoreKeptAttention,
  windows,
  scratchFolders,
  artifactFolders,
  hostPaneGrants,
  paneLauncherDir,
  keepShellsOn,
  keptShellsProgram,
  withKeptProcess,
  keptPaneEnv,
})

const { spawnManagerPty } = createManagerPty({ loadPty, primaryWindowId, trackPty, feedPty })

const { wireWindow } = createWindowWiring({
  contextMenuText: () => mainStrings().native.contextMenu,
  services,
  quit,
  readSettingsFile,
  requestQuit: () => requestQuit(),
  openExternalSafe,
  previews,
  extensionOfPartition,
  browserProfiles,
  hardenExtensionGuest,
  browserAgentsOf,
  instrumentBrowserGuest,
  fenceBrowserGuest,
  allowHumanPopups,
  consoleBuffers,
  errorBuffers,
  windows,
  hidePtyFlow,
  releaseWindowPtys,
  openWaits,
  commandsByWindow,
  browserPanes,
  ptys,
})

const {
  createWindow,
  revealWindow,
  emitFocusChanged,
  toggleAllWindows,
  applyGlobalHotkey,
  revealApp,
} = createAppWindows({ wireWindow, services, readSettingsFile, windows })

function configDir(): string {
  return appConfigDir()
}

function remoteCwdOfPane(paneId: string): RemoteCwd | undefined {
  return normalizeRemoteCwd(terminalState.get(paneId)?.remote) ?? undefined
}

const managerResumePath = (): string => storePath('manager-resume', 'global')
const scriptTokensPath = (): string => storePath('script-tokens-v2', 'global')
const retiredScriptTokensPath = (): string => storePath('retired-script-tokens', 'global')
const scriptTokenUsage = createScriptTokenUsage(() => storePath('script-token-usage', 'global'), {
  known: () => new Set(listScriptTokens(scriptTokensPath()).map((t) => t.id)),
})

function onSettingsWritten(): void {
  settingsChanged()
  services.telemetry?.settingsChanged()
  refreshCapabilitySettings()
  services.extensionHost?.refreshLocale()
  services.extensionHost?.assistant.reloadAssistSettings()
  services.gitService?.settingsChanged()
  services.portsService?.settingsChanged()
  applyGlobalHotkey()
  services.releaseChecks?.settingsChanged()
}

function openSettingsInFocusedWindow(): void {
  const focused = BrowserWindow.getFocusedWindow()
  const entry = [...windows].find(([, win]) => win === focused)
  void execCommand({ windowId: entry?.[0], workspaceId: '', paneId: null }, 'app.openSettings')
}

function runMenuCommandInFocusedWindow(command: string): void {
  const focused = BrowserWindow.getFocusedWindow()
  const win = focused && [...windows.values()].includes(focused) ? focused : mainWindow()
  if (win && !win.isDestroyed()) win.webContents.send('app-menu:run', command)
}

function reloadFocusedWindow(): void {
  const focused = BrowserWindow.getFocusedWindow()
  const win = focused && [...windows.values()].includes(focused) ? focused : mainWindow()
  if (win && !win.isDestroyed()) services.diagnostics?.reloadWindow(win.webContents)
}

const {
  extensionConnections,
  extensionSecretStore,
  assistKeyStore,
  encryptedFile,
  encryptedStore,
} = createEncryptedStores()

const languagePackDeps = {
  languages: () => services.extensionHost?.contributions.languages() ?? [],
  onError: (extId: string, error: string) => console.warn(`[language pack ${extId}] ${error}`),
}

const { registerMarketplaceIpc } = createMarketplaceIpc({
  openFileGrants,
  services,
  officialMarketplaceId,
  editorLanguageOf,
})

const { refreshAgentPlugins, extensionRoots, registerExtensionIpc, registerRemoteFilesIpc } =
  createExtensionIpc({ services, configDir, workspaceWindowId, terminalState, remoteCwdOfPane })

const mainStrings = createMainStrings({ ...languagePackDeps, locale: readLocale })

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

function boot(): void {
  setPaneIdSalt(loadPaneIdSalt(storePath('pane-id-salt', 'global')))
  const appMenu = installAppMenu(process.platform, {
    productName: PRODUCT_DISPLAY_NAME,
    text: () => mainStrings().native.appMenu,
    openSettings: openSettingsInFocusedWindow,
    runCommand: runMenuCommandInFocusedWindow,
    reloadWindow: reloadFocusedWindow,
  })
  ipcMain.on('app-menu:set', (e, spec: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && [...windows.values()].includes(win)) appMenu.setSpec(spec)
  })
  const logDir = join(app.getPath('userData'), 'logs')
  services.appLog = createAppLog(join(logDir, LOG_FILE_NAME))
  void resolveLoginPath().then(({ path, ms }) =>
    services.appLog?.info('login-path', { found: path !== null, ms }),
  )
  services.telemetry = registerTelemetry({
    file: join(app.getPath('userData'), TELEMETRY_FILE),
    version: appVersion(),
    stamp: runningBuild()?.telemetry,
    readSettings: readSettingsFile,
    locale: readLocale,
    session: telemetrySessionFacts,
    log: (event, fields) => services.appLog?.info(event, fields),
  })
  services.diagnostics = registerDiagnostics({
    log: services.appLog,
    telemetry: services.telemetry,
    version: appVersion(),
    logDir,
    testHooks: process.env.NODE_ENV === 'test',
    startRecovery,
    finishRecovery,
    openPath: (path) => shell.openPath(path),
  })
  handleQuitSignals()
  services.restoreOutcome = loadRestoredScrollback()
  services.appLog?.info('scrollback-load', {
    outcome: services.restoreOutcome,
    panes: Object.keys(pendingRestoredScrollback()).length,
  })
  startKeptShells({ ...wiring })
  startArtifacts({ ...wiring })
  registerWindowInputGuards({ ...wiring })
  registerWindowIpc({ ...wiring })
  registerPaneLifecycleIpc({ ...wiring })
  registerBrowserGuestIpc({ ...wiring })
  registerWorkspaceIpc()
  registerSandboxIpcWiring({ ...wiring })
  registerPtyIpc({ ...wiring })
  registerFsIpc({ ...wiring })
  registerSelectionIpc(reachesPane, redactor.text)
  registerArtifactViewIpc({ ...wiring })
  registerPrivacyIpc(redactor)
  registerApprovalsWiring({ ...wiring })
  startUpdates({ ...wiring })
  registerAgentTranscriptIpc()
  registerResumeClaimIpc(
    createResumeClaimer(() =>
      listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
    ),
  )
  registerFolderTrustIpc({ ...wiring, readSettingsFile })
  const { notifyDeps } = registerNotifyWiring({ ...wiring })
  registerSandboxWiring({ ...wiring, notifyDeps })
  const { registry } = registerAgentWiring({ ...wiring })
  const { paneHibernated } = registerPaneMethodsWiring({ ...wiring, registry })
  registerToolbeltWiring({ ...wiring, paneHibernated })
  const { extensionRemoteFolders, extensionExec, resumeOfPane } = extensionHostParts({ ...wiring })
  const { extensionStore, extensionHost } = startExtensionHost({
    ...wiring,
    extensionRemoteFolders,
    notifyDeps,
    extensionExec,
    resumeOfPane,
  })
  const { marketplace } = startMarketplace({ ...wiring, extensionStore })
  startProfileSyncWiring({ ...wiring, marketplace })
  startChat({ ...wiring })
  const { viewHost } = registerContentIpc({ ...wiring })
  startGateway({ ...wiring })
  registerBrowserWiring({ ...wiring })
  startControlServer({ ...wiring, notifyDeps })
  startManager({ ...wiring })
  startWindows({
    ...wiring,
    extensionHost,
    viewHost,
  })
}

app.whenReady().then(boot)

const redactionScan = createWorkerScan(redactionWorkerScript(app.getAppPath()))
const redactor = createRedactor(
  () => (readSettingsFile() as { privacy?: unknown }).privacy,
  redactionScan.scan,
)

const quitTrace = createQuitTrace((event, fields) => services.appLog?.info(event, fields))

const { persistScrollback, SCROLLBACK_AUTOSAVE_MS, autosaveScrollback } =
  createScrollbackPersistence({ redactor, services, ptys, isScratchPane, quit, quitTrace })

const { teardown } = createQuitTeardown({
  quitTrace,
  services,
  ptys,
  quit,
  keptHostPanes,
  syncKeptExposed,
  portForwarder,
  keptShells,
  languageServerWatches,
  workspaceSandboxes,
  workspaceAgents,
  scratchFolders,
  artifactFolders,
  artifactHistory,
  previews,
  updatePolicy,
})

const { requestQuit, handleQuitSignals } = registerAppQuit({
  teardown,
  readSettingsFile,
  services,
  quitTrace,
  quit,
  windows,
  ptys,
  mainWindow,
  scratchFolders,
  paneActivity,
  mainStrings,
  persistScrollback,
  scriptTokenUsage,
})

const wiring = {
  services,
  mainStrings,
  windows,
  requestQuit,
  startCoreBoards,
  toggleAllWindows,
  applyGlobalHotkey,
  createWindow,
  holdPtys,
  execCommand,
  agentRunning,
  workspaceSandboxes,
  scratchFolders,
  showWindow,
  emitFocusChanged,
  autosaveScrollback,
  SCROLLBACK_AUTOSAVE_MS,
  revealApp,
  registerManagerIpc,
  managerSettings,
  paneIo,
  openWorker,
  managerResumePath,
  createManagerPane,
  spawnManagerPty,
  startPortal,
  retiredScriptTokensPath,
  scriptTokensPath,
  workspaceListing,
  broadcast,
  scriptTokenUsage,
  getTerminalState,
  ptyPid,
  windowIds,
  isWaking,
  listCommandsFor,
  workspaceWindowId,
  primaryWindowId,
  reach,
  keptPlumbing,
  keepShellsOn,
  browserAgentsOf,
  browserProfiles,
  browserFence,
  browserPanes,
  consoleBuffers,
  errorBuffers,
  reachesPane,
  redactor,
  openExternalSafe,
  phoneFileScope,
  artifactFolders,
  attachPhoneObserver,
  ptyResize,
  ptyWrite,
  askHub,
  ptys,
  configDir,
  languagePackDeps,
  encryptedStore,
  encryptedFile,
  fileRoots,
  redactionScan,
  managedServers,
  serverOverrides,
  extensionConnections,
  extensionSecretStore,
  assistKeyStore,
  registerMarketplaceIpc,
  officialMarketplaceId,
  publishRemoteFolders,
  refreshAgentPlugins,
  hostPaneGrants,
  extensionRoots,
  terminalState,
  remoteCwdOfPane,
  sendToWorkspaceWindow,
  publishWorkspaceChips,
  openFileGrants,
  openTerminalInWindow,
  agentOffers,
  focusPaneInWindow,
  registerExtensionIpc,
  registerRemoteFilesIpc,
  createLanguageServers,
  openWaits,
  artifactProducers,
  artifactsChanged,
  keptAttention,
  paneWaking,
  workspaceCommandTarget,
  paneWatch,
  agentWork,
  startedAgents,
  agentChanges,
  syncKeptMeta,
  killPty,
  domainRequests,
  portRequests,
  secretService,
  scanSandboxPorts,
  PORT_SCAN_MS,
  isScratchPane,
  paneOutput,
  onSettingsWritten,
  emitPaneEvent,
  previews,
  paneAttentionEvents,
  releaseMovingPane,
  closedPanes,
  hibernatedPanes,
  workspaceClosed,
  keptShells,
  commandsByWindow,
  instrumentBrowserGuest,
  attachPty,
  hibernatePty,
  releasePtyFlow,
  paneActivity,
  foregroundProgram,
  agentCwd,
  sandboxReadRules,
  windowOfPane,
  readSettingsFile,
  portableExport,
  artifactHistory,
  sandboxViolations,
  quit,
  UPDATE_HOST_GRANT_ID,
  updatePolicy,
  revealWindow,
  settingsChanged,
  savedPaneIds,
  paneLauncherDir,
}
