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
import { BrowserWindow, ClipboardItem, app, clipboard, ipcMain, shell } from 'electron'
import type { DiscreteGpuInfo } from '../shared/app/discreteGpu'
import { isMacInstall, replacesInApp } from '../shared/app/installMethod'
import { ChangeSignal } from '../shared/common/actThenConfirm'
import { externalHref } from '../shared/common/externalLinks'
import { bucketCount } from '../shared/privacy/telemetry'
import { parseKeepShells } from '../shared/terminal/keepShells'
import type { CommandDescriptor, CommandTarget, TerminalStateSnapshot } from '../shared/types'
import { createAgentOfferRelay } from './agents/agentOfferRelay'
import { AgentRunningPanes } from './agents/agentRunning'
import { registerAgentTranscriptIpc } from './agents/agentTranscript'
import { registerAgentWiring } from './agents/agentWiring'
import { ReportedAgentWork } from './agents/agentWork'
import type { OriginReach } from './agents/originAgents'
import { createResumeClaimer, registerResumeClaimIpc } from './agents/resumeClaims'
import { registerToolbeltWiring } from './agents/toolbeltWiring'
import { approvals, registerApprovals } from './approvals/approvals'
import { createAskHub } from './approvals/asks'
import { loadReachMode, refreshCapabilitySettings } from './approvals/capabilityStore'
import { registerPermissionAsk } from './approvals/permissionAsk'
import { questions, registerExtensionQuestions, registerQuestions } from './approvals/questions'
import { type ReachListing, createReach } from './approvals/reach'
import { createScriptTokenUsage } from './approvals/scriptTokenUsage'
import {
  listScriptTokens,
  recordCreatedWorkspace,
  scriptTokenScope,
} from './approvals/scriptTokens'
import { registerArtifactIpc } from './artifacts/artifactFolders'
import { registerArtifactHistoryIpc } from './artifacts/artifactHistory'
import { registerArtifactProducersIpc } from './artifacts/artifactProducers'
import { createArtifactServices } from './artifacts/artifactServices'
import { registerPreviewIpc } from './artifacts/htmlPreview'
import { registerPortableIpc } from './artifacts/portableExport'
import { targetOf } from './attention/attention'
import { registerNotifyWiring } from './attention/notifyWiring'
import type { ConsoleEntry } from './browser/browseMethod'
import { registerBrowserGuestIpc } from './browser/browserGuestIpc'
import { createBrowserGuests } from './browser/browserGuests'
import { registerBrowserWiring } from './browser/browserWiring'
import { registerCredentials } from './browser/credentials'
import { type GuestChords, registerGuestChords } from './browser/guestChords'
import { createGuestProfiles } from './browser/guestProfiles'
import { startChat } from './chat/chatWiring'
import { registerExtensionMcp } from './chat/extensionMcp'
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
import {
  type SessionFacts,
  TELEMETRY_FILE,
  type Telemetry,
  registerTelemetry,
} from './diagnostics/telemetry'
import type { ExtensionHost } from './extensions/extensionHost'
import { startExtensionHost } from './extensions/extensionWiring'
import { extensionHostParts } from './extensions/extensionWiring'
import { createExtensionIpc } from './extensions/extensionWiring'
import { marketplaceId, normalizeMarketplaceUrl } from './extensions/marketplace/marketplace'
import { createMarketplaceIpc } from './extensions/marketplace/marketplaceIpc'
import { startMarketplace } from './extensions/marketplace/marketplaceWiring'
import { PaneAttentionEvents } from './extensions/paneAttentionEvents'
import { createMainStrings } from './extensions/strings'
import type { FileWatches } from './files/fileWatch'
import { registerFsIpc } from './files/fsIpc'
import { OpenWaits } from './files/openWaits'
import { startGateway } from './gateway/gatewayWiring'
import { phoneCanRespond } from './gateway/server'
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
import { discreteGpu, gpuStartPlan, querySwitcherooGpus } from './platform/discreteGpu'
import { loadJson, saveJson, storePath } from './platform/jsonStore'
import { managerSettings, readLocale, readSettingsFile } from './platform/settingsFile'
import {
  SANDBOX_FEATURE,
  missingRequirements,
  requirementLabel,
} from './platform/systemRequirements'
import { registerSystemRequirementsIpc } from './platform/systemRequirementsIpc'
import { loginPathSettled, resolveLoginPath } from './platform/toolPath'
import { appConfigDir } from './platform/userDirs'
import type { PortsService } from './ports/service'
import { registerPrivacyIpc } from './privacy/privacyIpc'
import { createRedactor } from './privacy/redaction'
import { createWorkerScan, redactionWorkerScript } from './privacy/redactionScan'
import type { ProfileSyncHandle } from './profileSync/ipc'
import { startProfileSyncWiring } from './profileSync/profileSyncWiring'
import { registerSandboxIpc } from './sandbox/ipc'
import { createSandboxServices } from './sandbox/sandboxServices'
import { registerSandboxWiring } from './sandbox/sandboxWiring'
import { createEncryptedStores } from './secrets/encryptedStores'
import { createSecretServices } from './secrets/secretServices'
import { writeOstiaLauncher } from './terminal/paneLauncher'
import { createPtyAttach } from './terminal/pty/ptyAttach'
import { createPtyIo } from './terminal/pty/ptyIo'
import { registerPtyIpc } from './terminal/pty/ptyIpc'
import { createLiveAttach } from './terminal/pty/ptyLiveAttach'
import { createPtyQueries } from './terminal/pty/ptyQueries'
import { createPtyRecovery } from './terminal/pty/ptyRecovery'
import { type PtyEntry, createPtyRegistry } from './terminal/pty/ptyRegistry'
import { createSandboxSpawn } from './terminal/pty/ptySandboxSpawn'
import { createSpawnPlanner } from './terminal/pty/ptySpawnPlan'
import { createPtyStart } from './terminal/pty/ptyStart'
import { createPtyStop } from './terminal/pty/ptyStop'
import type { SubscriberRole } from './terminal/ptySession'
import { registerSelectionIpc } from './terminal/selectionReport'
import type { SavedAttention } from './tmux/attentionFile'
import { KeptAttention } from './tmux/keptAttention'
import { createKeptReattach } from './tmux/keptReattach'
import { createKeptShellsWiring } from './tmux/keptShellsWiring'
import { createKeptSpawner } from './tmux/keptSpawn'
import { registerAppUpdate } from './updates/appUpdate'
import { appVersion, runningBuild } from './updates/appVersion'
import { installAppDir, installMethod } from './updates/installMethod'
import {
  type PendingSweep,
  canReplaceInstall,
  createInstallReplacer,
  releaseDownloadBase,
  runTar,
  tarballReplace,
} from './updates/installReplace'
import { sweepUpdateLeftovers } from './updates/launchSweep'
import { canReplaceBundle, macReplace, runCommand, signaturePolicy } from './updates/macReplace'
import {
  announceReplace,
  announceReplaceProgress,
  announceUpdateRun,
  readUpdateChannel,
  registerReleaseCheck,
} from './updates/releaseCheck'
import { type UpdateRunner, createUpdateRunner } from './updates/updateRun'
import { installAppMenu } from './windows/appMenu'
import { registerAppQuit } from './windows/appQuit'
import { createAppWindows } from './windows/appWindows'
import { type ClipboardEdits, registerClipboardEdits } from './windows/clipboardEdits'
import type { GlobalHotkey } from './windows/globalHotkey'
import { createQuitTrace } from './windows/quitPlan'
import { createQuitTeardown } from './windows/quitTeardown'
import { type AppTray, isHiddenLaunch } from './windows/tray'
import type { WindowBroker } from './windows/windowBroker'
import { registerWindowIpc } from './windows/windowIpc'
import { createWindowSend } from './windows/windowSend'
import { startWindows } from './windows/windowStartup'
import { createWindowWiring } from './windows/windowWiring'
import { registerCmuxSessionIpc } from './workspaces/cmuxSession'
import { registerContentIpc } from './workspaces/contentWiring'
import { registerScratchIpc } from './workspaces/scratchFolders'
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

interface AppServices {
  appLog: AppLog | null
  diagnostics: Diagnostics | null
  telemetry: Telemetry | null
  restoreOutcome: RestoreOutcome
  marketplaceInstallIds: () => string[]
  processes: ProcessRegistry | null
  updateRunner: UpdateRunner | null
  languageServers: LanguageServers | null
  onSandboxSpawnFailure: ((workspaceId: string, errors: string[]) => void) | null
  extensionHost: ExtensionHost | null
  gitService: GitService | null
  portsService: PortsService | null
  viewHost: ViewHost | null
  mcpHost: McpHost | null
  mcpOAuth: McpOAuth | null
  broker: WindowBroker | null
  profileSync: ProfileSyncHandle | null
  stopTailnet: (() => Promise<void>) | null
  stopAnnouncing: (() => void) | null
  clipboardEdits: ClipboardEdits | null
  guestChords: GuestChords | null
  appTray: AppTray | null
  globalHotkey: GlobalHotkey | null
  releaseChecks: { settingsChanged: () => void } | null
  managerService: ManagerService | null
  managerLimiter: ManagerLimiter | null
  portal: Portal | null
  fileWatches: FileWatches | null
}

interface QuitState {
  restartRequested: boolean
  stagedUpdate: { pending: PendingSweep; sweepFile: string } | null
  quitApproved: boolean
  scrollbackSavedForQuit: boolean
  savingScrollbackForQuit: boolean
}

const quit: QuitState = {
  restartRequested: false,
  stagedUpdate: null,
  quitApproved: false,
  scrollbackSavedForQuit: false,
  savingScrollbackForQuit: false,
}

const services: AppServices = {
  appLog: null,
  diagnostics: null,
  telemetry: null,
  restoreOutcome: 'none',
  marketplaceInstallIds: () => [],
  processes: null,
  updateRunner: null,
  languageServers: null,
  onSandboxSpawnFailure: null,
  extensionHost: null,
  gitService: null,
  portsService: null,
  viewHost: null,
  mcpHost: null,
  mcpOAuth: null,
  broker: null,
  profileSync: null,
  stopTailnet: null,
  stopAnnouncing: null,
  clipboardEdits: null,
  guestChords: null,
  appTray: null,
  globalHotkey: null,
  releaseChecks: null,
  managerService: null,
  managerLimiter: null,
  portal: null,
  fileWatches: null,
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

function telemetrySessionFacts(): SessionFacts {
  const settings = readSettingsFile() as {
    behavior?: { inputMode?: unknown; gpuAcceleration?: unknown }
    terminal?: { renderer?: unknown; prompt?: { style?: unknown } }
  }
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback
  const installed = services.marketplaceInstallIds()
  const enabled =
    services.extensionHost
      ?.list()
      .filter((ext) => ext.enabled && installed.includes(ext.id))
      .map((ext) => ext.id) ?? []
  let workspaces = 0
  for (const win of windows.values()) {
    if (!win.isDestroyed()) workspaces += services.broker?.workspacesOf(win).length ?? 0
  }
  return {
    windows: bucketCount(windows.size),
    workspaces: bucketCount(workspaces),
    restore: services.restoreOutcome,
    inEffect: {
      features: {
        input_mode: text(settings.behavior?.inputMode, 'terminal'),
        prompt_style: text(settings.terminal?.prompt?.style, 'shell'),
      },
      terminal: {
        engine: text(settings.terminal?.renderer, 'xterm'),
        gpu: settings.behavior?.gpuAcceleration === false ? 'off' : 'on',
      },
    },
    installedExtensions: installed,
    enabledExtensions: enabled,
  }
}

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

const { loadPty, feedPty, trackPty } = createPtyRegistry({
  ptys,
  movingPanes,
  recoveryHeld,
  closedPanes,
  scheduleReap: (paneId, entry) => scheduleReap(paneId, entry),
  openWaits,
  agentRunning,
  agentWork,
  keptAttention,
  processes: () => services.processes,
  appLog: () => services.appLog,
})

const { killPty, hibernatePty } = createPtyStop({
  ptys,
  recoveryHeld,
  closedPanes,
  hibernatedPanes,
  startedAgents,
  terminalState,
  keptShells,
  agentWork,
  paneWaking,
  telemetry: () => services.telemetry,
  appLog: () => services.appLog,
})

const { paneActivity, sandboxReadRules, ptyPid, paneOutput } = createPtyQueries({
  ptys,
  agentRunning,
  workspaceSandboxes,
})

const { paneIo, releasePtyFlow, hidePtyFlow, attachMirror, ptyResize, ptyWrite } = createPtyIo({
  ptys,
})

const {
  windowOfPane,
  scheduleReap,
  startRecovery,
  finishRecovery,
  releaseWindowPtys,
  holdPtys,
  releaseMovingPane,
} = createPtyRecovery({
  ptys,
  movingPanes,
  recoveryHeld,
  closedPanes,
  killPty,
  appLog: () => services.appLog,
})

const { spawnSandboxed } = createSandboxSpawn({
  workspaceSandboxes,
  keptShells,
  injectSecrets,
  onSandboxSpawnFailure: () => services.onSandboxSpawnFailure,
})

const { reattachKept } = createKeptReattach({
  workspaceSandboxes,
  keptShells,
  keptPlumbing,
  keptAttention,
  agentRunning,
  hibernatedPanes,
  portRequests,
  trackPty,
  feedPty,
  releaseMergedSandbox,
  restoreKeptAttention,
  processes: () => services.processes,
  appLog: () => services.appLog,
})

const { subscriberFor, attachExisting } = createLiveAttach({ windows, movingPanes, recoveryHeld })

const { planSpawn } = createSpawnPlanner({
  scratchFolders,
  artifactFolders,
  hostPaneGrants,
  workspaceSandboxes,
  readSettingsFile,
  paneLauncherDir,
  keepShellsOn,
  keptShellsProgram,
  telemetry: () => services.telemetry,
})

const { spawnKept } = createKeptSpawner({
  keptShells,
  keptPlumbing,
  withKeptProcess,
  keptPaneEnv,
  appLog: () => services.appLog,
})

const { startTracked } = createPtyStart({
  keptShells,
  workspaceSandboxes,
  hibernatedPanes,
  trackPty,
  feedPty,
  releaseMergedSandbox,
  telemetry: () => services.telemetry,
  appLog: () => services.appLog,
})

const { attachPty } = createPtyAttach({
  ptys,
  keptShells,
  loadPty,
  subscriberFor,
  attachExisting,
  reattachKept,
  planSpawn,
  spawnSandboxed,
  spawnKept,
  startTracked,
  telemetry: () => services.telemetry,
})

const { spawnManagerPty } = createManagerPty({ loadPty, primaryWindowId, trackPty, feedPty })

const { wireWindow } = createWindowWiring({
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

let gwSubSeq = 0

export function attachPhoneObserver(
  rendererPaneId: string,
  opts: {
    sinceCursor?: number
    role?: 'observer' | 'owner'
    sendData: (data: string) => void
  },
): { cursor: number; dropped: boolean; cols: number; rows: number; detach: () => void } | null {
  const entry = ptys.get(rendererPaneId)
  if (!entry) return null
  const id = `gw-${++gwSubSeq}`
  const role: SubscriberRole = opts.role === 'owner' ? 'owner' : 'observer'
  const { cursor, dropped } = entry.session.addSubscriber(
    { id, role, send: (data) => opts.sendData(data) },
    opts.sinceCursor ?? 0,
  )
  return {
    cursor,
    dropped,
    cols: entry.pty.cols,
    rows: entry.pty.rows,
    detach: () => entry.session.removeSubscriber(id),
  }
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

app.whenReady().then(() => {
  setPaneIdSalt(loadPaneIdSalt(storePath('pane-id-salt', 'global')))
  const appMenu = installAppMenu(process.platform, {
    productName: PRODUCT_DISPLAY_NAME,
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
  void keptShells
    .start(parseKeepShells(readSettingsFile().terminal?.keepShells), savedPaneIds())
    .then(() => {
      const kept = keptShells.keptHostWorkspaces()
      for (const workspaceId of kept) {
        const host = keptShells.keptHost(workspaceId)
        if (host) workspaceSandboxes.adoptKeptTmp(workspaceId, host.tmpDir)
      }
      workspaceSandboxes.sweepKeptTmp(kept)
    })
  try {
    writeOstiaLauncher(paneLauncherDir())
  } catch (err) {
    services.appLog?.warn('launcher-write-failed', {
      launcher: 'pane',
      code: (err as NodeJS.ErrnoException).code ?? null,
    })
  }
  scratchFolders.sweep()
  artifactFolders.sweep()
  artifactHistory.sweep()
  portableExport.sweep()
  workspaceSandboxes.sweepTmp()
  registerScratchIpc(scratchFolders)
  registerArtifactIpc({
    folders: artifactFolders,
    ownsWorkspace: (windowId, workspaceId) => windowForWorkspace(workspaceId) === windowId,
  })
  registerCmuxSessionIpc()
  services.clipboardEdits = registerClipboardEdits({
    ipc: ipcMain,
    isAppWindow: (sender) => windows.get(String(sender.id))?.webContents === sender,
    snapshot: async () => {
      const items = await clipboard.read()
      const listed = items.find((item) => item.types.includes('text/uri-list'))
      return {
        formats: items.flatMap((item) => item.types),
        uriList: listed ? await (await listed.getType('text/uri-list')).text() : '',
      }
    },
    mac: process.platform === 'darwin',
  })
  services.guestChords = registerGuestChords({
    ipc: ipcMain,
    isAppWindow: (sender) => windows.get(String(sender.id))?.webContents === sender,
    mac: process.platform === 'darwin',
  })
  registerWindowIpc({ requestQuit })
  registerPaneLifecycleIpc({
    windows,
    emitPaneEvent,
    previews,
    paneAttentionEvents,
    artifactProducers,
    openWaits,
    services,
    releaseMovingPane,
    killPty,
    ptys,
    closedPanes,
    hibernatedPanes,
    browserProfiles,
    terminalState,
    paneWaking,
    paneWatch,
    scratchFolders,
    workspaceClosed,
    keptShells,
    commandsByWindow,
    remoteCwdOfPane,
  })
  registerBrowserGuestIpc({
    browserProfiles,
    browserPanes,
    instrumentBrowserGuest,
    consoleBuffers,
    errorBuffers,
  })
  registerWorkspaceIpc()
  registerSandboxIpc({
    sandboxes: workspaceSandboxes,
    ownerWindow: windowForWorkspace,
    missing: () => missingRequirements(SANDBOX_FEATURE),
    domains: domainRequests,
    ports: portRequests,
    violations: sandboxViolations,
    refreshAll: () => workspaceSandboxes.refreshAll(),
  })
  registerSystemRequirementsIpc({
    ownerWindow: windowForWorkspace,
    workDir: (workspaceId) => workDirForWorkspace(workspaceId),
    locale: readLocale,
    systemExtensionEnabled: () =>
      services.extensionHost?.list().some((ext) => ext.id === 'system' && ext.enabled) ?? false,
    missing: (feature) => missingRequirements(feature),
    settled: loginPathSettled,
    label: requirementLabel,
    invokeInstall: (args, caller) =>
      services.extensionHost
        ? services.extensionHost.invoke('system', 'install', args, caller)
        : Promise.resolve({ ok: false, error: 'extension-unavailable' }),
  })
  ipcMain.handle('system:discrete-gpu', async (): Promise<DiscreteGpuInfo | null> => {
    if (process.platform !== 'linux') return null
    const gpu = discreteGpu(await querySwitcherooGpus())
    return gpu ? { name: gpu.name, inUse: gpuStartPlan(process.env, gpu).kind === 'stay' } : null
  })
  registerPtyIpc({
    attachPty,
    ptys,
    terminalState,
    keptShells,
    openWaits,
    agentWork,
    agentRunning,
    paneWaking,
    hibernatePty,
    killPty,
    releasePtyFlow,
    paneActivity,
    sandboxReadRules,
    windowOfPane,
    readSettingsFile,
  })
  registerFsIpc({ ...wiring })
  registerSelectionIpc(reachesPane, redactor.text)
  registerPreviewIpc(previews, (png) => {
    void clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)]) })])
  })
  registerPortableIpc(portableExport)
  registerArtifactHistoryIpc({
    history: artifactHistory,
    ownsWorkspace: (windowId, workspaceId) => windowForWorkspace(workspaceId) === windowId,
  })
  registerArtifactProducersIpc({
    producers: artifactProducers,
    ownsWorkspace: (windowId, workspaceId) => windowForWorkspace(workspaceId) === windowId,
  })
  registerPrivacyIpc(redactor)
  const approvalCaps = new Map<string, readonly string[]>()
  registerApprovals(revealWindow, settingsChanged, {
    opened: (request) => {
      approvalCaps.set(request.id, request.caps)
      for (const cap of request.caps) services.telemetry?.count('agents', 'approval_shown', cap)
      askHub.approvalOpened(request)
    },
    settled: (id, outcome) => {
      const caps = approvalCaps.get(id) ?? []
      approvalCaps.delete(id)
      if (outcome !== 'timeout' && outcome !== 'auto') {
        for (const cap of caps) services.telemetry?.count('agents', 'approval_answered', cap)
      }
      askHub.settled(id, outcome)
    },
  })
  registerQuestions({
    opened: (request) => {
      services.telemetry?.count('agents', 'question_asked')
      askHub.questionOpened(request)
    },
    settled: (id, outcome) => {
      if (outcome === 'answered') services.telemetry?.count('agents', 'question_answered')
      askHub.settled(id, outcome)
    },
  })
  registerExtensionMcp({ mcp: () => services.mcpHost })
  registerExtensionQuestions({
    windowOfWorkspace: windowForWorkspace,
    extensionName: (extId) => services.extensionHost?.displayName(extId) ?? extId,
  })
  registerPermissionAsk({ questions, phoneCanAnswer: phoneCanRespond })
  registerCredentials()
  registerAppUpdate(() => {
    quit.restartRequested = true
    requestQuit()
  })
  services.updateRunner = createUpdateRunner({
    method: installMethod,
    title: () => mainStrings().native.updateTitle,
    openTerminal: (req) => openTerminalInWindow(req),
    hostToken: (command) => {
      hostPaneGrants.offer(UPDATE_HOST_GRANT_ID, command)
      return hostPaneGrants.claim(UPDATE_HOST_GRANT_ID, command) ?? ''
    },
    onChange: announceUpdateRun,
  })
  const sweepFile = storePath('install-replace', 'global')
  const macInstall = isMacInstall(installMethod())
  void sweepUpdateLeftovers({
    pending: loadJson<PendingSweep | null>(sweepFile, null),
    appDir: installAppDir(),
    version: appVersion(),
    macInstall,
    swept: () => saveJson(sweepFile, null),
    warn: (event) => services.appLog?.warn(event),
  })
  const updateDir = (): string | null =>
    replacesInApp(installMethod(), readUpdateChannel(readSettingsFile())) ? installAppDir() : null
  const downloadBase = releaseDownloadBase(app.isPackaged, process.env)
  services.releaseChecks = registerReleaseCheck({
    openExternal: openExternalSafe,
    readSettings: readSettingsFile,
    log: services.appLog,
    version: appVersion(),
    method: installMethod,
    updateRunner: services.updateRunner,
    replaceAvailability: async () => {
      const dir = updateDir()
      if (!dir) return null
      return macInstall ? canReplaceBundle(dir) : canReplaceInstall(dir)
    },
    replacer: createInstallReplacer({
      appDir: updateDir,
      replace: macInstall
        ? macReplace({
            base: downloadBase,
            fetch,
            run: runCommand,
            policy: updatePolicy,
          })
        : tarballReplace({ base: downloadBase, fetch, tar: runTar }),
      onState: announceReplace,
      onProgress: announceReplaceProgress,
      onReplaced: (pending) => {
        if (macInstall) quit.stagedUpdate = { pending, sweepFile }
        else saveJson(sweepFile, pending)
      },
    }),
  })
  registerAgentTranscriptIpc()
  registerResumeClaimIpc(
    createResumeClaimer(() =>
      listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
    ),
  )
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
})

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
}
