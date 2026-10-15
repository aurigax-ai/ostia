import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { MANAGER_CAPABILITIES } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type {
  ExtensionEventPayloads,
  ExtensionEventType,
  ExtensionPanelContext,
  ExtensionResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import {
  OFFICIAL_MARKETPLACE,
  PRODUCT_NAME,
} from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import {
  type RemoteCwd,
  normalizeRemoteCwd,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { agentPluginContent } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import type { ExtensionRoot } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import { BrowserWindow, ClipboardItem, app, clipboard, ipcMain, shell } from 'electron'
import type { IPty } from 'node-pty'
import type { AgentResume } from '../shared/agents/agentResume'
import { MANAGER_FEATURE, parseManagerSettings } from '../shared/agents/managerSettings'
import type { DiscreteGpuInfo } from '../shared/app/discreteGpu'
import { isMacInstall, replacesInApp } from '../shared/app/installMethod'
import { parseGitSettings } from '../shared/boards/git'
import { parsePortsSettings } from '../shared/boards/ports'
import { ChangeSignal } from '../shared/common/actThenConfirm'
import { externalHref } from '../shared/common/externalLinks'
import { EXTENSION_SUGGESTIONS } from '../shared/extensions/extensionSuggestions'
import { bucketCount } from '../shared/privacy/telemetry'
import { parseKeepShells } from '../shared/terminal/keepShells'
import { quoteArgv } from '../shared/terminal/shellQuote'
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
import { loadReachMode, refreshCapabilitySettings, setCaps } from './approvals/capabilityStore'
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
import { controlSocketPath } from './control/controlServer'
import { startControlServer } from './control/controlWiring'
import { emitPlatformEvent } from './control/events'
import {
  type PaneIdentity,
  getByPaneId,
  markManager,
  registerPane,
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
import { registerConnectionsIpc } from './extensions/connectionsIpc'
import type { ExtensionHost } from './extensions/extensionHost'
import { DismissedSuggestions, suggestionFor } from './extensions/extensionSuggestions'
import { startMarketplace } from './extensions/extensionWiring'
import { startExtensionHost } from './extensions/extensionWiring'
import { extensionHostParts } from './extensions/extensionWiring'
import { type Marketplace, marketplaceId, normalizeMarketplaceUrl } from './extensions/marketplace'
import { PaneAttentionEvents } from './extensions/paneAttentionEvents'
import { createMainStrings } from './extensions/strings'
import { workspaceChipsForWindow } from './extensions/workspaceChips'
import type { FileWatches } from './files/fileWatch'
import { registerFsIpc } from './files/fsIpc'
import { OpenWaits } from './files/openWaits'
import { registerRemoteFolderConfirm } from './files/remoteFolderConfirm'
import { startGateway } from './gateway/gatewayWiring'
import { phoneCanRespond } from './gateway/server'
import { GitCommands } from './git/commands'
import { confirmDiscard } from './git/confirmDiscard'
import { registerGitIpc, registerGitMethods } from './git/register'
import { GitService } from './git/service'
import { ViewStateStore } from './git/viewState'
import { createLanguageServerWiring } from './lsp/languageServerWiring'
import type { LanguageServers } from './lsp/languageServers'
import { type ManagerService, managerWindowId } from './manager/manager'
import {
  managerArgv,
  writeManagerClaudePlugin,
  writeManagerCodexContext,
} from './manager/managerAgent'
import type { ManagerLimiter } from './manager/managerMethods'
import { startManager } from './manager/managerWiring'
import { Portal, portalSocketPath, portalSupported } from './manager/portal'
import { callerVerdict, procFs, ttysOf } from './manager/portalCaller'
import { registerPaneLifecycleIpc } from './panes/paneLifecycleIpc'
import { listPanes, listWorkspaceGroups, listWorkspaces } from './panes/paneList'
import { registerPaneMethodsWiring } from './panes/paneMethodsWiring'
import { PaneWatch } from './panes/paneWait'
import { PaneWaking } from './panes/paneWaking'
import type { ProcessRegistry } from './panes/processRegistry'
import { discreteGpu, gpuStartPlan, querySwitcherooGpus } from './platform/discreteGpu'
import { loadJson, saveJson, storePath } from './platform/jsonStore'
import { privateTmpDir } from './platform/privateTmp'
import { readLocale, readSettingsFile } from './platform/settingsFile'
import {
  SANDBOX_FEATURE,
  installHint,
  missingRequirements,
  requirementLabel,
} from './platform/systemRequirements'
import { registerSystemRequirementsIpc } from './platform/systemRequirementsIpc'
import { loginPathSettled, resolveLoginPath } from './platform/toolPath'
import { appConfigDir } from './platform/userDirs'
import { registerPortsIpc, registerPortsMethods } from './ports/register'
import { PortsService } from './ports/service'
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
import { setAgentPlugins } from './terminal/shellIntegration'
import { spawnFolder } from './terminal/spawnCwd'
import {
  PTY_COLOR_ENV,
  PTY_TERM_NAME,
  ptyHyperlinkEnv,
  ptyIdentityEnv,
  ptyLocaleEnv,
} from './terminal/terminalType'
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

function refreshAgentPlugins(): void {
  try {
    setAgentPlugins(
      agentPluginContent(
        services.extensionHost?.contributions.agentPlugins() ?? [],
        (extId, problem) => console.error(`[ext:${extId}] ${problem}`),
      ),
    )
  } catch (err) {
    console.error(`agent plugins: ${(err as Error).message}`)
  }
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

function extensionRoots(): ExtensionRoot[] {
  const builtinDir = app.isPackaged
    ? join(process.resourcesPath, 'extensions')
    : join(app.getAppPath(), 'out/extensions')
  return [
    { dir: builtinDir, builtin: true },
    { dir: join(configDir(), 'extensions'), builtin: false },
  ]
}

function registerIpc(): void {
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
}

function registerExtensionIpc(host: ExtensionHost): void {
  ipcMain.handle('extensions:list', () => host.list())
  ipcMain.handle('extensions:set-enabled', (_e, extId: string, enabled: boolean) =>
    host.processes.setEnabled(String(extId), enabled === true),
  )
  ipcMain.handle('extensions:approve', (_e, extId: string) => host.processes.approve(String(extId)))
  ipcMain.handle('extensions:sidebar', () => host.slots.sidebarItems())
  ipcMain.handle('extensions:chips', () => host.slots.paneChips())
  ipcMain.handle('extensions:workspace-chips', (e) =>
    workspaceChipsForWindow(host.slots.workspaceChips(), workspaceWindowId, String(e.sender.id)),
  )
  ipcMain.handle('extensions:set-setting', (_e, extId: unknown, key: unknown, value: unknown) => {
    if (typeof extId === 'string' && services.marketplaceInstallIds().includes(extId)) {
      services.telemetry?.count('extensions', 'setting_change', `${extId}.${String(key)}`)
    }
    return host.config.setSetting(String(extId), String(key), value)
  })
  ipcMain.handle('extensions:set-secret', (_e, extId: unknown, key: unknown, value: unknown) =>
    host.config.setSecret(String(extId), String(key), value),
  )
  registerConnectionsIpc(() => host?.config ?? null)
  ipcMain.handle(
    'extensions:invoke',
    (
      _e,
      extId: string,
      command: string,
      target: { workspaceId: string | null; paneId: string | null },
      argument?: unknown,
    ): Promise<ExtensionResult> => {
      const paneId = target?.paneId ? getByPaneId(target.paneId)?.externalId : undefined
      const cwd = target?.paneId ? terminalState.get(target.paneId)?.cwd : undefined
      const remote = target?.paneId ? remoteCwdOfPane(target.paneId) : undefined
      const caller = host.userCaller(target?.workspaceId ?? null, {
        capabilities: host.commandCapabilities(extId, command),
        ...(paneId ? { paneId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(remote ? { remote } : {}),
      })
      return host.invoke(extId, command, host.paletteArgs(extId, command, argument), caller)
    },
  )
  ipcMain.handle('extensions:panel', (_e, extId: string, context: ExtensionPanelContext) =>
    host.panels.resolvePanel(String(extId), {
      workspaceId: String(context?.workspaceId ?? ''),
      locale: String(context?.locale ?? 'en'),
      ...(context?.path === undefined ? {} : { path: String(context.path) }),
    }),
  )
}

function remoteCwdOfPane(paneId: string): RemoteCwd | undefined {
  return normalizeRemoteCwd(terminalState.get(paneId)?.remote) ?? undefined
}

function registerRemoteFilesIpc(host: ExtensionHost): void {
  const folders = host.remoteFolders
  if (!folders) return
  registerRemoteFolderConfirm()
  const sender = (e: Electron.IpcMainInvokeEvent): string => String(e.sender.id)
  ipcMain.handle('remote-files:folders', (e) => folders.forWindow(sender(e)))
  ipcMain.handle('remote-files:close', (e, folderId: unknown) =>
    folders.closeByWindow(sender(e), folderId),
  )
  ipcMain.handle('remote-files:list', (e, path: unknown) => folders.list(sender(e), path))
  ipcMain.handle('remote-files:stat', (e, path: unknown) => folders.stat(sender(e), path))
  ipcMain.handle('remote-files:read', (e, path: unknown) => folders.read(sender(e), path))
  ipcMain.handle('remote-files:write', (e, path: unknown, content: unknown, baseVersion: unknown) =>
    folders.write(sender(e), path, content, baseVersion),
  )
}

function registerMarketplaceIpc(marketplace: Marketplace): void {
  ipcMain.handle('marketplace:list', () => marketplace.state())
  ipcMain.handle('marketplace:add', (_e, url: unknown) => marketplace.add(url))
  ipcMain.handle('marketplace:remove', (_e, id: unknown, uninstallExtensions: unknown) =>
    marketplace.remove(id, uninstallExtensions),
  )
  ipcMain.handle('marketplace:refresh', (_e, id: unknown) => marketplace.refresh(id))
  ipcMain.handle('marketplace:install', (_e, id: unknown, extId: unknown) =>
    marketplace.install(id, extId),
  )
  ipcMain.handle('marketplace:install-code', (_e, id: unknown, code: unknown) =>
    marketplace.installCode(id, code),
  )
  ipcMain.handle('marketplace:uninstall', (_e, extId: unknown) => marketplace.uninstall(extId))

  const dismissed = new DismissedSuggestions(
    join(app.getPath('userData'), 'extension-suggestions.json'),
  )
  ipcMain.handle('suggestions:for-file', (e, paneId: unknown, path: unknown) => {
    if (typeof paneId !== 'string' || typeof path !== 'string') return null
    if (getByPaneId(paneId)?.windowId !== String(e.sender.id)) return null
    const file = openFileGrants.confine(path)
    if (file === null) return null
    return suggestionFor(file, {
      servers: () => services.extensionHost?.contributions.languageServers() ?? [],
      extensions: () => services.extensionHost?.list() ?? [],
      listings: () => marketplace.languageListings(),
      dismissed: () => dismissed.list(),
      official: officialMarketplaceId,
      languageOf: editorLanguageOf,
    })
  })
  ipcMain.handle('suggestions:dismiss', (_e, extId: unknown) => dismissed.dismiss(extId))
  ipcMain.handle('suggestions:install', (_e, extId: unknown) =>
    marketplace.installSuggested(
      extId,
      OFFICIAL_MARKETPLACE,
      typeof extId === 'string' && Object.hasOwn(EXTENSION_SUGGESTIONS, extId),
    ),
  )
}

function registerSandboxSystemIpc(): void {
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
}

function paneEnv(paneId: string, windowId: string, cwd: string): Record<string, string> {
  const identity = registerPane({ windowId, workspaceId: '', paneId })
  return appEnv({
    PANE_ID: identity.externalId,
    TOKEN: identity.token,
    START_DIR: cwd,
    SOCKET: controlSocketPath(),
    CLI: join(app.getAppPath(), 'out/cli/index.js'),
    NODE: process.execPath,
  })
}

function managerLaunchArgv(argv: string[], resume: AgentResume | null): string[] {
  const { skills } = managerSettings()
  const base = privateTmpDir(`${PRODUCT_NAME}-manager`)
  const claudePluginDir = join(base, 'claude-plugin')
  writeManagerClaudePlugin(claudePluginDir, skills)
  const codexContextFile = writeManagerCodexContext(join(base, 'codex'), skills)
  return managerArgv(argv, { claudePluginDir, codexContextFile, resume })
}

const managerResumePath = (): string => storePath('manager-resume', 'global')
const scriptTokensPath = (): string => storePath('script-tokens-v2', 'global')
const retiredScriptTokensPath = (): string => storePath('retired-script-tokens', 'global')
const scriptTokenUsage = createScriptTokenUsage(() => storePath('script-token-usage', 'global'), {
  known: () => new Set(listScriptTokens(scriptTokensPath()).map((t) => t.id)),
})

function spawnManagerPty(req: {
  paneId: string
  argv: string[]
  cwd: string
  cols: number
  rows: number
  path?: string
  resume: AgentResume | null
  onExit: () => void
}): boolean {
  const mod = loadPty()
  const windowId = getByPaneId(req.paneId)?.windowId || primaryWindowId()
  const [file, ...args] = managerLaunchArgv(req.argv, req.resume)
  if (!mod || !windowId || !file) return false
  const { cwd } = spawnFolder(req.cwd)
  const env = {
    ...process.env,
    ...(req.path === undefined ? {} : { PATH: req.path }),
    ...paneEnv(req.paneId, windowId, cwd),
    ...ptyLocaleEnv(process.env, app.getLocale()),
    ...ptyHyperlinkEnv(process.env),
    ...PTY_COLOR_ENV,
    ...ptyIdentityEnv(app.getVersion()),
  } as Record<string, string>
  const identity = markManager(req.paneId)
  if (identity) setCaps(identity.externalId, MANAGER_CAPABILITIES)
  let pty: IPty
  try {
    pty = mod.spawn(file, args, {
      name: PTY_TERM_NAME,
      cols: req.cols,
      rows: req.rows,
      cwd,
      env,
    })
  } catch (err) {
    console.error('[manager] spawn failed', err)
    return false
  }
  const entry = trackPty(req.paneId, pty, {
    cols: req.cols,
    rows: req.rows,
    subs: new Map(),
    spawnPath: env.PATH ?? '',
    stateFile: join(privateTmpDir(`${PRODUCT_NAME}-shell-state`), randomUUID()),
    keepAlive: true,
  })
  entry.exitListeners.add(() => req.onExit())
  pty.onData((d) => feedPty(entry, d))
  pty.onExit(({ exitCode }) => entry.session.exit(exitCode))
  return true
}

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

function startCoreBoards(): void {
  const panes = () =>
    listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking })
  const service = new GitService({
    settings: () => parseGitSettings(readSettingsFile().git),
    listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
    listPanes: panes,
    send: sendToWindow,
    log: (line) => console.error(`[git] ${line}`),
  })
  services.gitService = service
  const commands = new GitCommands({
    settings: () => parseGitSettings(readSettingsFile().git),
    text: () => mainStrings().git,
    cwdOf: (workspaceId) => service.cwdOf(workspaceId),
    views: new ViewStateStore(join(app.getPath('userData'), 'git-view.json')),
    openDiff: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-diff', req),
    confirmDiscard: (prompt) => confirmDiscard(prompt, windows.values()),
    touched: () => service.touched(),
  })
  registerGitMethods({
    commands,
    callerOf: (identity) => ({
      workspaceId: identity.workspaceId,
      workDir: workDirForWorkspace(identity.workspaceId),
      cwd: terminalState.get(identity.paneId)?.cwd,
    }),
  })
  registerGitIpc({
    commands,
    service,
    ownerWindow: workspaceWindowId,
    workDirOf: workDirForWorkspace,
  })
  const ports = new PortsService({
    settings: () => parsePortsSettings(readSettingsFile().ports),
    listPanes: panes,
    rendererPaneId: (externalId) => resolveExternal(externalId)?.paneId,
    send: sendToWindow,
    log: (line) => console.error(`[ports] ${line}`),
  })
  services.portsService = ports
  registerPortsMethods(ports)
  registerPortsIpc(ports)
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

const mainStrings = createMainStrings({ ...languagePackDeps, locale: readLocale })

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

const MANAGER_READY_TIMEOUT_MS = 20_000
const MANAGER_OPEN_TIMEOUT_MS = 5000
const managerReadyWindows = new Set<string>()
const managerReadyWaiters = new Set<() => void>()
let managerOpenSeq = 0

function registerManagerIpc(): void {
  ipcMain.on('manager:ready', (e) => {
    managerReadyWindows.add(String(e.sender.id))
    for (const wake of managerReadyWaiters) wake()
    managerReadyWaiters.clear()
  })
}

function managerWindow(): Promise<BrowserWindow | null> {
  const ready = (): BrowserWindow | null => {
    const id = managerWindowId(primaryWindowId(), managerReadyWindows)
    const win = id ? windows.get(id) : undefined
    return win && !win.isDestroyed() ? win : null
  }
  const now = ready()
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer)
      managerReadyWaiters.delete(wake)
      resolve(ready())
    }
    const timer = setTimeout(wake, MANAGER_READY_TIMEOUT_MS)
    managerReadyWaiters.add(wake)
  })
}

async function createManagerPane(req: { agent: string; cwd: string }): Promise<string | null> {
  const win = await managerWindow()
  if (!win) return null
  const wid = String(win.webContents.id)
  const requestId = `manager-${++managerOpenSeq}`
  return new Promise((resolve) => {
    const finish = (paneId: string | null): void => {
      clearTimeout(timer)
      ipcMain.removeListener('manager:open-result', onResult)
      resolve(paneId)
    }
    const onResult = (e: Electron.IpcMainEvent, rid: unknown, paneId: unknown): void => {
      if (rid !== requestId || String(e.sender.id) !== wid) return
      finish(typeof paneId === 'string' && paneId ? paneId : null)
    }
    const timer = setTimeout(() => finish(null), MANAGER_OPEN_TIMEOUT_MS)
    ipcMain.on('manager:open-result', onResult)
    win.webContents.send('manager:open', requestId, req)
  })
}

function managerSettings() {
  return parseManagerSettings(readSettingsFile().manager)
}

async function openWorker(req: {
  argv: string[]
  cwd?: string
  workspaceId?: string
  name?: string
}): Promise<string | null> {
  let workspaceId = req.workspaceId
  if (!workspaceId) {
    const created = await reach.byAgent(() =>
      execCommand({ workspaceId: '', paneId: null }, 'workspace.new', {
        ...(req.cwd ? { dir: req.cwd } : {}),
        ...(req.name ? { name: req.name } : {}),
      }),
    )
    const result = created.ok ? (created.result as { workspaceId?: unknown }) : undefined
    if (typeof result?.workspaceId !== 'string') return null
    workspaceId = result.workspaceId
  }
  return openTerminalInWindow({
    command: quoteArgv(req.argv),
    workspaceId,
    ...(req.cwd ? { cwd: req.cwd } : {}),
    title: req.argv[0],
  })
}

function startPortal(): void {
  if (!services.managerService || !portalSupported(process.platform)) return
  const service = services.managerService
  services.portal = new Portal(portalSocketPath(app.isPackaged), {
    missing: () => missingRequirements(MANAGER_FEATURE),
    hint: (missing) => installHint(missing),
    judge: (socket) =>
      callerVerdict(socket, {
        mainPid: process.pid,
        paneTtys: ttysOf(
          [...ptys.values()].map((entry) => entry.pty.pid),
          procFs,
        ),
        proc: procFs,
      }),
    manager: service,
    attachMirror,
  })
  services.portal
    .start()
    .then((started) => {
      if (!started) console.warn(`[portal] another ${PRODUCT_DISPLAY_NAME} owns the portal socket`)
    })
    .catch((err) => console.error('[portal] failed to start', err))
}

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
  registerIpc()
  registerWorkspaceIpc()
  registerSandboxSystemIpc()
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
