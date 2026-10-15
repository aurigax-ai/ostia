import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { appEnv, readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
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
import {
  BrowserWindow,
  ClipboardItem,
  app,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeTheme,
  safeStorage,
  session,
  shell,
} from 'electron'
import type { IPty } from 'node-pty'
import appIcon from '../../resources/icon.png?asset'
import { parseAgentHooks } from '../shared/agents/agentHooks'
import { type AgentResume, isResumableAgent, parseAgentResume } from '../shared/agents/agentResume'
import {
  MANAGER_FEATURE,
  managerAgents,
  parseManagerSettings,
} from '../shared/agents/managerSettings'
import { fmt } from '../shared/app/dict'
import type { DiscreteGpuInfo } from '../shared/app/discreteGpu'
import { isMacInstall, replacesInApp } from '../shared/app/installMethod'
import { isPreviewPartition } from '../shared/artifacts/htmlPreview'
import { parseChatToolSettings } from '../shared/assist/chatTools'
import { parseGitSettings } from '../shared/boards/git'
import { parsePortsSettings } from '../shared/boards/ports'
import { SHARED_BROWSER_PARTITION } from '../shared/browser/browserProfile'
import { ChangeSignal } from '../shared/common/actThenConfirm'
import { externalHref } from '../shared/common/externalLinks'
import { EXTENSION_SUGGESTIONS } from '../shared/extensions/extensionSuggestions'
import { OPEN_FILES_COMMAND, OPEN_FILES_MAX } from '../shared/files/openFiles'
import { parsePrivacySettings } from '../shared/privacy/redaction'
import { bucketCount } from '../shared/privacy/telemetry'
import { parseKeepShells } from '../shared/terminal/keepShells'
import { quoteArgv } from '../shared/terminal/shellQuote'
import type {
  CommandDescriptor,
  CommandTarget,
  FsEntry,
  FsKind,
  QuitAnswer,
  TerminalStateSnapshot,
  WindowBounds,
} from '../shared/types'
import { AGENT_OFFER_RESULT_CHANNEL, createAgentOfferRelay } from './agents/agentOfferRelay'
import { AgentRunningPanes } from './agents/agentRunning'
import { registerAgentTranscriptIpc } from './agents/agentTranscript'
import { ReportedAgentWork, registerAgentWorkMethods } from './agents/agentWork'
import { registerBusMethods, tellPane } from './agents/bus'
import type { OriginReach } from './agents/originAgents'
import { createResumeClaimer, registerResumeClaimIpc } from './agents/resumeClaims'
import { approvals, registerApprovals } from './approvals/approvals'
import { createAskHub } from './approvals/asks'
import { loadReachMode, refreshCapabilitySettings, setCaps } from './approvals/capabilityStore'
import { registerPermissionAsk } from './approvals/permissionAsk'
import { questions, registerExtensionQuestions, registerQuestions } from './approvals/questions'
import { type ReachListing, createReach } from './approvals/reach'
import { registerScriptTokenIpc } from './approvals/scriptTokenIpc'
import { createScriptTokenUsage } from './approvals/scriptTokenUsage'
import {
  checkScriptToken,
  listScriptTokens,
  recordCreatedWorkspace,
  registerScriptTokenMethods,
  retireLegacyScriptTokens,
  scriptTokenScope,
  setUserPresenceCheck,
} from './approvals/scriptTokens'
import { electronPresenceDeps, verifyUserPresence } from './approvals/userPresence'
import { registerArtifactIpc } from './artifacts/artifactFolders'
import { registerArtifactHistoryIpc } from './artifacts/artifactHistory'
import { registerArtifactProducersIpc } from './artifacts/artifactProducers'
import { createArtifactServices } from './artifacts/artifactServices'
import { hardenPreviewAttach, registerPreviewIpc } from './artifacts/htmlPreview'
import { registerPortableIpc } from './artifacts/portableExport'
import { registerAttentionMethods, targetOf } from './attention/attention'
import { announceBusMessage } from './attention/busNotice'
import {
  postActionNotification,
  postNotification,
  postPanelNotification,
  registerNotifyIpc,
  registerNotifyMethods,
} from './attention/notify'
import { registerBrowseMethods } from './browser/browse'
import { clearGuestBrowseState, ownedGuest } from './browser/browseGuests'
import type { ConsoleEntry } from './browser/browseMethod'
import { registerPickIpc, registerPickMethods } from './browser/browsePick'
import { registerRegionIpc } from './browser/browseRegion'
import { registerBrowserGuestIpc } from './browser/browserGuestIpc'
import { createBrowserGuests } from './browser/browserGuests'
import { registerBrowserStorageIpc } from './browser/browserStorage'
import { credentials, registerCredentials } from './browser/credentials'
import { type GuestChords, registerGuestChords } from './browser/guestChords'
import { forgetGuestNetwork } from './browser/guestNetwork'
import { registerLoginFill } from './browser/loginFill'
import { followAgentByHost } from './browser/signinUserAgent'
import { registerAssistIpc } from './chat/assistIpc'
import { createChatSessionStore } from './chat/chatSessions'
import { registerChatSessionIpc } from './chat/chatSessionsIpc'
import { ChatToolGrants } from './chat/chatToolGrants'
import { registerChatToolsIpc } from './chat/chatToolsIpc'
import { registerExtensionMcp } from './chat/extensionMcp'
import { McpHost } from './chat/mcpHost'
import { McpOAuth, mcpOAuthBrowser } from './chat/mcpOAuth'
import { createMcpOAuthStore } from './chat/mcpOAuthStore'
import { createCommandBridge } from './control/commandBridge'
import { setCapFilter, setScriptTokenCheck } from './control/controlAuth'
import { clearControlInfo, controlInfoPath, writeControlInfo } from './control/controlDiscovery'
import {
  controlSocketPath,
  registerControlServer,
  stopControlServer,
} from './control/controlServer'
import { registerDocsMethods } from './control/docs'
import { emitPlatformEvent, platformEvents } from './control/events'
import {
  type PaneIdentity,
  getByPaneId,
  markManager,
  moveToWorkspace,
  registerPane,
  rehomeWorkspace,
  removeWindow,
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
import { confirmForExtension } from './extensions/extensionConfirm'
import { ExtensionExec } from './extensions/extensionExec'
import { ExtensionHost } from './extensions/extensionHost'
import { ExtensionLaunches } from './extensions/extensionLaunches'
import { registerExtensionMethods } from './extensions/extensionMethods'
import { ExtensionStore } from './extensions/extensionStore'
import { DismissedSuggestions, suggestionFor } from './extensions/extensionSuggestions'
import { registerIconThemeIpc } from './extensions/iconThemes'
import { describeSkipped, registerKeymapIpc } from './extensions/keymaps'
import { registerLanguagePackIpc } from './extensions/languagePacks'
import { Marketplace, marketplaceId, normalizeMarketplaceUrl } from './extensions/marketplace'
import { PaneAttentionEvents } from './extensions/paneAttentionEvents'
import { createMainStrings } from './extensions/strings'
import { workspaceChipsForWindow } from './extensions/workspaceChips'
import { FileOps } from './files/fileOps'
import { FileWatches } from './files/fileWatch'
import { readBinaryConfined } from './files/fsBinary'
import { readTextConfined, versionConfined, writeText, writeTextConfined } from './files/fsText'
import { openFileForExtension, registerOpenFileMethods } from './files/openFileMethods'
import { registerOpenPathIpc } from './files/openPath'
import { OpenWaits } from './files/openWaits'
import { confirmRemoteFolder, registerRemoteFolderConfirm } from './files/remoteFolderConfirm'
import { ripgrepPath } from './files/ripgrep'
import { createWorkspaceClosed } from './files/workspaceClosed'
import { registerSearchIpc } from './files/workspaceSearch'
import { createBonjourPublisher } from './gateway/announce'
import {
  configureAnnouncer,
  configureTailnet,
  onTailnetChange,
  registerGatewayIpc,
  registerGatewayMethods,
} from './gateway/gatewayIpc'
import { listPairRequests, onPairRequestsChanged } from './gateway/pairRequests'
import { configureGatewayControl, phoneCanRespond, stopGateway } from './gateway/server'
import { createTailnet, tailnetNodeName, tsnetHelperPath } from './gateway/tailnet'
import { GitCommands } from './git/commands'
import { confirmDiscard } from './git/confirmDiscard'
import { registerGitIpc, registerGitMethods } from './git/register'
import { GitService } from './git/service'
import { ViewStateStore } from './git/viewState'
import { registerEditorLanguageIpc } from './lsp/editorLanguages'
import { createLanguageServerWiring } from './lsp/languageServerWiring'
import type { LanguageServers } from './lsp/languageServers'
import { registerLanguageServersIpc } from './lsp/languageServersIpc'
import { ManagerService, managerWindowId } from './manager/manager'
import {
  managerArgv,
  writeManagerClaudePlugin,
  writeManagerCodexContext,
} from './manager/managerAgent'
import { type ManagerLimiter, registerManagerMethods } from './manager/managerMethods'
import { Portal, portalSocketPath, portalSupported } from './manager/portal'
import { callerVerdict, procFs, ttysOf } from './manager/portalCaller'
import { registerExtensionWake } from './panes/extensionWake'
import { type PaneAttentionPeek, registerPaneIoMethods } from './panes/paneIo'
import { registerPaneLifecycleIpc } from './panes/paneLifecycleIpc'
import {
  listPanes,
  listWorkspaceGroups,
  listWorkspaces,
  registerPaneListMethods,
} from './panes/paneList'
import { registerPaneMoveIpc } from './panes/paneMove'
import { registerPaneMoveToMethods } from './panes/paneMoveTo'
import type { PaneReachDeps } from './panes/paneReach'
import { registerPaneRenameMethods } from './panes/paneRename'
import { registerPaneResumeMethods } from './panes/paneResume'
import { PaneWatch, registerPaneWaitMethods } from './panes/paneWait'
import { wakeHibernatedPane } from './panes/paneWake'
import { PaneWaking } from './panes/paneWaking'
import { INTERRUPT_GRACE_MS, processStatusOf, registerProcessMethods } from './panes/processManager'
import type { ProcessRegistry } from './panes/processRegistry'
import { discreteGpu, gpuStartPlan, querySwitcherooGpus } from './platform/discreteGpu'
import { loadJson, saveJson, storePath } from './platform/jsonStore'
import { expandHome, resolveSafe } from './platform/pathGuard'
import { privateTmpDir } from './platform/privateTmp'
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
import { createRedactor, createScrollbackRedactor } from './privacy/redaction'
import { createWorkerScan, redactionWorkerScript } from './privacy/redactionScan'
import { type ProfileSyncHandle, startProfileSync } from './profileSync/ipc'
import { flatSource, groupedSource, loginsSource } from './profileSync/secrets'
import { registerSandboxMethods } from './sandbox/controlMethods'
import { registerSandboxIpc } from './sandbox/ipc'
import { createSandboxServices } from './sandbox/sandboxServices'
import { sandboxSpawnEnv } from './sandbox/spawnEnv'
import { reportSandboxSpawnFailure } from './sandbox/spawnFailureNotice'
import { createEncryptedStores } from './secrets/encryptedStores'
import { registerSecretMethods } from './secrets/register'
import { createSecretServices } from './secrets/secretServices'
import { deleteGlobalVaultValue, registerVaultMethods, setGlobalVaultValue } from './secrets/vault'
import { registerCompletionIpc } from './terminal/completionSpecs'
import { writeOstiaLauncher } from './terminal/paneLauncher'
import { createPtyAttach } from './terminal/pty/ptyAttach'
import { createPtyIo } from './terminal/pty/ptyIo'
import { registerPtyIpc } from './terminal/pty/ptyIpc'
import { createLiveAttach } from './terminal/pty/ptyLiveAttach'
import { createPtyQueries } from './terminal/pty/ptyQueries'
import { createPtyRecovery } from './terminal/pty/ptyRecovery'
import {
  type PaneTitleEntry,
  type PtyEntry,
  createPtyRegistry,
  removeStateFile,
} from './terminal/pty/ptyRegistry'
import { createSandboxSpawn } from './terminal/pty/ptySandboxSpawn'
import { createSpawnPlanner } from './terminal/pty/ptySpawnPlan'
import { createPtyStart } from './terminal/pty/ptyStart'
import { createPtyStop } from './terminal/pty/ptyStop'
import type { SubscriberRole } from './terminal/ptySession'
import { registerSelectionIpc } from './terminal/selectionReport'
import { setAgentPlugins } from './terminal/shellIntegration'
import { spawnFolder } from './terminal/spawnCwd'
import { TerminalPathLinks, registerTerminalPathLinkIpc } from './terminal/terminalPathLinks'
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
import {
  canReplaceBundle,
  macReplace,
  runCommand,
  signaturePolicy,
  swapStagedBundle,
  verifyStagedSync,
} from './updates/macReplace'
import {
  announceReplace,
  announceReplaceProgress,
  announceUpdateRun,
  readUpdateChannel,
  registerReleaseCheck,
} from './updates/releaseCheck'
import { type UpdateRunner, createUpdateRunner } from './updates/updateRun'
import { installAppMenu } from './windows/appMenu'
import { type ClipboardEdits, registerClipboardEdits } from './windows/clipboardEdits'
import { confirmQuit, freezeAll } from './windows/closeGuard'
import { attachContextMenu } from './windows/contextMenu'
import { GlobalHotkey, toggleWindows } from './windows/globalHotkey'
import {
  QUIT_SIGNALS,
  createQuitTrace,
  exitAfterDeadline,
  keepsShellsOnQuit,
  keptOnQuit,
  planQuit,
  summarizeKinds,
} from './windows/quitPlan'
import { nativeQuitConfirm } from './windows/quitPrompt'
import {
  AppTray,
  closeAction,
  isHiddenLaunch,
  readCloseToTray,
  unreadWorkspaces,
} from './windows/tray'
import { MAIN_SLOT } from './windows/windowBook'
import { WindowBroker } from './windows/windowBroker'
import { registerWindowIpc } from './windows/windowIpc'
import { createWindowSend } from './windows/windowSend'
import { registerCmuxSessionIpc } from './workspaces/cmuxSession'
import { registerProjectRootIpc } from './workspaces/projectRoot'
import { registerSameFolder } from './workspaces/sameFolder'
import { registerScratchIpc } from './workspaces/scratchFolders'
import { type SnippetDeps, registerSnippetIpc, registerSnippetMethods } from './workspaces/snippets'
import { ViewHost, ViewStore } from './workspaces/viewHost'
import { registerViewMethods, registerViewsIpc } from './workspaces/viewsIpc'
import { registerWorkspaceMergeIpc } from './workspaces/workspaceMerge'
import {
  removeWorkspace,
  windowForWorkspace,
  workDirForWorkspace,
} from './workspaces/workspaceRegistry'
import {
  type RestoreOutcome,
  loadRestoredScrollback,
  pendingRestoredScrollback,
  saveScrollback,
  scrollbackToSave,
} from './workspaces/workspaceSnapshot'

const devServerUrl = process.env.ELECTRON_RENDERER_URL

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

function listDir(dir: string): FsEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  } catch {
    return []
  }
}

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
let telemetrySentForQuit = false
let sendingTelemetryForQuit = false

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
let quitAnswer: QuitAnswer | null = null
const updatePolicy = signaturePolicy(app.isPackaged, process.env)
const UPDATE_HOST_GRANT_ID = 'core:update'

function confirmQuitOn(): boolean {
  return readSettingsFile().workspaces?.confirmQuit !== false
}

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

const {
  browserProfiles,
  browserFence,
  fenceBrowserGuest,
  extensionOfPartition,
  browserAgentsOf,
  instrumentBrowserGuest,
  allowHumanPopups,
  hardenExtensionGuest,
} = createBrowserGuests({
  scratchFolders,
  workspaceSandboxes,
  domainRequests,
  browserPanes,
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

function frameOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 11 } }
  }
  return { frame: false }
}

function baseWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(app.getAppPath(), 'out/preload/index.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: true,
  }
}
let quitAsking = false
let quitRequested = false

function requestQuit(): void {
  quitRequested = true
  app.quit()
}
let quitSignaled = false

function handleQuitSignals(): void {
  for (const signal of QUIT_SIGNALS) {
    process.on(signal, () => {
      services.appLog?.info('quit-signal', { signal })
      quitSignaled = true
      app.quit()
    })
  }
}
const startedHidden = app.commandLine.hasSwitch('hidden')

function wireWindow(win: BrowserWindow): void {
  win.once('ready-to-show', () => {
    if (startedHidden && services.appTray) services.appTray.hide(win)
    else win.show()
  })

  win.on('close', (event) => {
    if (quit.quitApproved || services.broker?.isReturning(win)) return
    const action = closeAction({
      quitApproved: quit.quitApproved,
      closeToTray: readCloseToTray(readSettingsFile()),
      startedHidden,
      managerLive: services.managerService?.live != null,
    })
    if (action === 'hide' && services.appTray && !services.broker?.isDetached(win)) {
      event.preventDefault()
      services.appTray.hide(win)
      return
    }
    event.preventDefault()
    if (services.broker?.isDetached(win)) services.broker.requestReturn(win, true)
    else requestQuit()
  })

  const emitMaximized = (): void => win.webContents.send('window:maximized', win.isMaximized())
  win.on('maximize', emitMaximized)
  win.on('unmaximize', emitMaximized)

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })

  attachContextMenu(win.webContents, false)

  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (isPreviewPartition(params.partition)) {
      if (previews.acceptsAttach(params.partition, params.src, String(win.webContents.id))) {
        hardenPreviewAttach(webPreferences, params)
      } else {
        event.preventDefault()
      }
      return
    }
    const extId = extensionOfPartition(params.partition)
    const allowed = extId
      ? (services.extensionHost?.panels.isAllowedPanelUrl(extId, params.src) ?? false)
      : browserProfiles.acceptsAttach(params.partition, String(win.webContents.id))
    if (!allowed) {
      event.preventDefault()
      return
    }
    webPreferences.preload = undefined
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    Object.assign(webPreferences, {
      disablePopups: params.partition !== SHARED_BROWSER_PARTITION,
    })
  })
  win.webContents.on('did-attach-webview', (_e, guest) => {
    services.clipboardEdits?.guardGuest(guest)
    services.guestChords?.guardGuest(guest)
    if (previews.adopt(guest)) return
    if (hardenExtensionGuest(guest)) {
      attachContextMenu(guest, false)
      return
    }
    attachContextMenu(guest, true)
    const agents = browserAgentsOf(guest.session)
    guest.setUserAgent(agents.rewritten)
    instrumentBrowserGuest(guest, true)
    followAgentByHost(guest, agents)
    fenceBrowserGuest(guest)
    allowHumanPopups(guest)
    const wcId = guest.id
    guest.once('destroyed', () => {
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
      forgetGuestNetwork(wcId)
    })
  })

  const wid = String(win.webContents.id)
  windows.set(wid, win)
  services.diagnostics?.watchWindow(win)
  win.on('hide', () => hidePtyFlow(wid))
  win.on('minimize', () => hidePtyFlow(wid))
  win.on('closed', () => {
    windows.delete(wid)
    services.gitService?.windowGone(wid)
    services.portsService?.windowGone(wid)
    releaseWindowPtys(wid)
    previews.windowClosed(wid)
    openWaits.windowGone(wid)
    services.fileWatches?.unwatchOwner(wid)
    commandsByWindow.delete(wid)
    for (const [paneId, wcId] of browserPanes) {
      if (getByPaneId(paneId)?.windowId === wid) {
        browserPanes.delete(paneId)
        consoleBuffers.delete(wcId)
        errorBuffers.delete(wcId)
        clearGuestBrowseState(wcId)
        forgetGuestNetwork(wcId)
      }
    }
    removeWindow(wid)
    for (const entry of ptys.values()) {
      if (entry.subs.has(wid)) {
        entry.subs.delete(wid)
        entry.session.removeSubscriber(wid)
      }
    }
  })
}

function initialBackground(): string {
  const follow = (readSettingsFile() as { appearance?: { followSystem?: unknown } }).appearance
    ?.followSystem
  return follow !== false && !nativeTheme.shouldUseDarkColors ? '#fbfcfd' : '#1d2022'
}

function createWindow(slot: string, bounds?: WindowBounds): BrowserWindow {
  const win = new BrowserWindow({
    ...(bounds ?? { width: 1280, height: 800 }),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: initialBackground(),
    show: false,
    autoHideMenuBar: true,
    title: PRODUCT_DISPLAY_NAME,
    icon: appIcon,
    ...frameOptions(),
    webPreferences: baseWebPreferences(),
  })

  wireWindow(win)
  services.broker?.track(win, slot)

  if (devServerUrl) {
    win.loadURL(devServerUrl)
    if (slot === MAIN_SLOT) win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(app.getAppPath(), 'out/renderer/index.html'))
  }

  return win
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

const workspaceClosed = createWorkspaceClosed({
  openWaits,
  removeWorkspace,
  forgetReach: (id) => reach.forget(id),
  closeProcesses: (id) => services.processes?.workspaceClosed(id),
  clearChips: (id) => services.extensionHost?.slots.clearWorkspaceChips(id),
  closeRemoteFolders: (id) => services.extensionHost?.remoteFolders?.workspaceClosed(id),
  tellExtensions: (id) => services.extensionHost?.events.workspaceClosed(id),
  closeArtifacts: (id) => artifactHistory.close(id, artifactFolders.close(id)),
  removeScratch: (id) => scratchFolders.remove(id),
  forgetRequests: forgetWorkspaceRequests,
  forgetSandbox: forgetSandboxRuntime,
})

function forgetWorkspaceRequests(workspaceId: string): void {
  packageRequests.forget(workspaceId)
  void portForwarder.forget(workspaceId)
  portRequests.forget(workspaceId)
  domainRequests.forget(workspaceId)
}

function forgetSandboxRuntime(workspaceId: string): void {
  workspaceSandboxes.forget(workspaceId)
  sandboxViolations.clear(workspaceId)
  workspaceAgents.stop(workspaceId)
  secretService.forget(workspaceId)
}

const mergedSandboxes = new Set<string>()

function releaseMergedSandbox(workspaceId: string, exiting?: PtyEntry): void {
  if (!mergedSandboxes.has(workspaceId)) return
  for (const entry of ptys.values()) {
    if (entry !== exiting && entry.confinedBy === workspaceId) return
  }
  mergedSandboxes.delete(workspaceId)
  forgetSandboxRuntime(workspaceId)
}

function movePanesToWorkspace(paneIds: string[], sourceId: string, targetId: string): void {
  for (const paneId of paneIds) openWaits.paneMoved(paneId)
  for (const identity of moveToWorkspace(paneIds, targetId)) {
    emitPaneEvent('pane.created', {
      paneId: identity.externalId,
      workspaceId: targetId,
    })
  }
  for (const paneId of paneIds) {
    const entry = ptys.get(paneId)
    if (entry?.workspaceId === sourceId) entry.workspaceId = targetId
  }
}

function mergeWorkspace(sourceId: string, targetId: string): void {
  for (const identity of rehomeWorkspace(sourceId, targetId)) {
    emitPaneEvent('pane.created', {
      paneId: identity.externalId,
      workspaceId: targetId,
    })
  }
  for (const entry of ptys.values()) {
    if (entry.workspaceId === sourceId) entry.workspaceId = targetId
  }
  workspaceSandboxes.merge(sourceId, targetId)
  const movedArtifacts = artifactFolders.merge(sourceId, targetId)
  artifactProducers.merge(sourceId, targetId, movedArtifacts)
  artifactHistory.merge(sourceId, targetId, movedArtifacts)
  artifactHistory.close(sourceId, artifactFolders.close(sourceId))
  removeWorkspace(sourceId)
  forgetWorkspaceRequests(sourceId)
  mergedSandboxes.add(sourceId)
  releaseMergedSandbox(sourceId)
}

function registerWorkspaceIpc(): void {
  registerWorkspaceMergeIpc({
    ownerWindow: windowForWorkspace,
    hasManager: workspaceHasManager,
    sandboxRefusal: (sourceId, targetId) => workspaceSandboxes.mergeRefusal(sourceId, targetId),
    merge: mergeWorkspace,
  })
  registerPaneMoveIpc({
    ownerWindow: windowForWorkspace,
    paneOf: getByPaneId,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    movePanes: movePanesToWorkspace,
  })
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

const FILE_WATCH_DEBOUNCE_MS = 150

function registerFsIpc(): void {
  const allowedRoots = fileRoots()
  const settingsFile = join(app.getPath('userData'), 'settings.json')
  registerOpenPathIpc(allowedRoots, () => windows.values())
  registerTerminalPathLinkIpc(
    new TerminalPathLinks({
      grants: openFileGrants,
      home: homedir(),
      output: (paneId) => paneOutput(paneId),
      pane: (paneId) => getByPaneId(paneId),
      isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
      isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
      openFolder: (path) => shell.openPath(path),
    }),
  )
  registerProjectRootIpc(allowedRoots)
  registerSearchIpc(ripgrepPath(app.getAppPath(), process.platform, process.arch), allowedRoots)

  const fileOps = new FileOps({ roots: allowedRoots, trash: (path) => shell.trashItem(path) })
  ipcMain.handle('files:create', (_e, dir: unknown, name: unknown, kind: unknown) =>
    fileOps.create(dir, name, kind),
  )
  ipcMain.handle('files:rename', (_e, path: unknown, name: unknown) => fileOps.rename(path, name))
  ipcMain.handle('files:move', (_e, paths: unknown, dir: unknown) => fileOps.move(paths, dir))
  ipcMain.handle('files:copy', (_e, paths: unknown, dir: unknown) => fileOps.copy(paths, dir))
  ipcMain.handle('files:trash', (_e, paths: unknown) => fileOps.trash(paths))

  ipcMain.handle('fs:list', (_e, dir: string): FsEntry[] => {
    const safe = resolveSafe(dir, allowedRoots)
    if (safe === null) return []
    return listDir(safe)
  })

  ipcMain.handle('fs:stat', (_e, path: string): FsKind | null => {
    const safe = openFileGrants.confine(path)
    if (safe === null) return null
    try {
      const stat = statSync(safe)
      return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:read', (_e, path: unknown) =>
    readTextConfined(path, (candidate) => openFileGrants.confine(candidate)),
  )

  ipcMain.handle('fs:read-binary', (_e, path: unknown) =>
    readBinaryConfined(path, (candidate) => openFileGrants.confine(candidate)),
  )

  ipcMain.handle('files:admit-dropped', (_e, paths: unknown, workspaceId: unknown) => {
    if (!Array.isArray(paths) || paths.length > OPEN_FILES_MAX) return []
    const remember = typeof workspaceId !== 'string' || !scratchFolders.isScratch(workspaceId)
    return paths
      .filter((path): path is string => typeof path === 'string')
      .map((path) => openFileGrants.admit(path, { sandboxed: false, remember }))
  })

  services.fileWatches = new FileWatches({
    confine: (path) => openFileGrants.confine(path),
    debounceMs: FILE_WATCH_DEBOUNCE_MS,
    onChange: ({ path, exists, owners }) => {
      for (const owner of owners) {
        const win = windows.get(owner)
        if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { path, exists })
      }
    },
  })
  ipcMain.handle('fs:watch', (e, path: unknown): boolean =>
    typeof path === 'string'
      ? (services.fileWatches?.watch(String(e.sender.id), path) ?? false)
      : false,
  )
  ipcMain.on('fs:unwatch', (e, path: unknown) => {
    if (typeof path === 'string') services.fileWatches?.unwatch(String(e.sender.id), path)
  })

  ipcMain.handle('fs:version', (_e, path: unknown) =>
    versionConfined(path, (candidate) => openFileGrants.confine(candidate)),
  )

  ipcMain.handle(
    'fs:write',
    (e, path: string, content: string): Promise<boolean> =>
      writeTextConfined(
        path,
        (p) => openFileGrants.confine(p),
        async (safe) => {
          const save = () => writeText(safe, content)
          await (services.fileWatches?.write(String(e.sender.id), safe, content, save) ?? save())
          if (safe === settingsFile) {
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
        },
      ),
  )
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

function readSettingsFileOrNull(): { assistant?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'),
    )
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null
  }
}

function readSettingsFile(): {
  locale?: unknown
  extensionSettings?: unknown
  git?: unknown
  ports?: unknown
  workspaces?: { globalHotkey?: unknown; confirmQuit?: unknown }
  manager?: unknown
  assistant?: unknown
  privacy?: unknown
  terminal?: { shell?: unknown; keepShells?: unknown }
  agents?: { hooks?: unknown }
  behavior?: { historySuggestions?: unknown }
} {
  try {
    return JSON.parse(readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
}

function readLocale(): string | undefined {
  const locale = readSettingsFile().locale
  return typeof locale === 'string' ? locale : undefined
}

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

function revealWindow(windowId: string): void {
  const win = windows.get(windowId)
  if (win && !win.isDestroyed() && !win.isVisible()) services.appTray?.showWindows()
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

function emitFocusChanged(): void {
  const focused = BrowserWindow.getFocusedWindow() !== null
  services.extensionHost?.events.emitEvent('focus.changed', { focused })
  services.gitService?.setFocused(focused)
  services.portsService?.setFocused(focused)
}

function toggleAllWindows(): void {
  toggleWindows([...windows.values()], services.appTray, revealApp)
}

function applyGlobalHotkey(): void {
  const status = services.globalHotkey?.apply(readSettingsFile().workspaces?.globalHotkey)
  if (status === 'taken') console.warn('[global hotkey] the chosen shortcut is in use elsewhere')
}

function revealApp(): void {
  if (windows.size === 0) {
    createWindow(MAIN_SLOT, services.broker?.restoredBounds(MAIN_SLOT))
  } else services.appTray?.showWindows()
}

app.on('second-instance', (_event, argv) => {
  if (!app.isReady() || isHiddenLaunch(argv)) return
  revealApp()
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
  registerFsIpc()
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
  const notifyDeps = {
    execCommand,
    isScratchPane,
    windows: () => windows.values(),
    windowById: (id: string) => windows.get(id),
    redact: redactor.text,
  }
  registerNotifyMethods(notifyDeps)
  registerSandboxMethods({ domains: domainRequests, ports: portRequests })
  registerSecretMethods({
    service: secretService,
    sandboxes: workspaceSandboxes,
    ownerWindow: windowForWorkspace,
    vaultSet: setGlobalVaultValue,
    vaultDelete: deleteGlobalVaultValue,
  })
  if (process.platform === 'linux') setInterval(scanSandboxPorts, PORT_SCAN_MS).unref()
  services.onSandboxSpawnFailure = (workspaceId, errors) =>
    reportSandboxSpawnFailure(
      {
        notify: (input, onClick) =>
          postActionNotification(notifyDeps, { ...input, from: 'sandbox' }, onClick),
        showRequirements: (id, report) => {
          const windowId = windowForWorkspace(id)
          const win = windowId ? windows.get(windowId) : undefined
          if (!win || win.isDestroyed()) return
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
          win.webContents.send('sandbox:blocked', { workspaceId: id, report })
        },
        report: () => {
          const missing = missingRequirements(SANDBOX_FEATURE)
          return {
            missing,
            hint: installHint(missing),
            canInstall:
              services.extensionHost?.list().some((x) => x.id === 'system' && x.enabled) ?? false,
          }
        },
      },
      workspaceId,
      errors,
    )
  registerNotifyIpc(notifyDeps)
  registerAttentionMethods({ execCommand, reported: (paneId) => keptAttention.reported(paneId) })
  registerAgentWorkMethods(agentWork)
  registerPaneRenameMethods({ execCommand, reach, windowOfWorkspace: workspaceWindowId })
  registerPaneResumeMethods({
    execCommand,
    onResume: (identity, resume) => {
      services.telemetry?.count('agents', 'resume')
      paneWaking.end(identity.paneId, 'started')
      startedAgents.add(identity.paneId)
      agentChanges.fire()
      if (identity.manager) services.managerService?.rememberResume(resume)
    },
  })
  const registry = registerProcessMethods({
    openTab: openTerminalInWindow,
    onChange: (entry) => {
      syncKeptMeta(entry.paneId)
      paneWatch.emit(entry.paneId, { kind: 'state' })
    },
    ring: (paneId) => {
      const session = ptys.get(paneId)?.session
      return session ? (from) => session.since(from) : undefined
    },
    writePane: paneIo.write,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    endShell: (paneId) => killPty(paneId, 'process-kill'),
    hasShell: (paneId) => ptys.has(paneId),
    runInPane: (paneId, command) => {
      const windowId = getByPaneId(paneId)?.windowId
      const win = windowId ? windows.get(windowId) : undefined
      if (!win || win.isDestroyed()) return false
      win.webContents.send('pty:run', paneId, command)
      return true
    },
    cwdOfPane: (paneId) => terminalState.get(paneId)?.cwd,
    agentArgv: (name) => managerAgents(managerSettings())[name] ?? null,
    isAgent: (paneId) => agentRunning.has(paneId),
    agentStarted: (paneId) => startedAgents.has(paneId),
    startsWithHook: (argv) => {
      const program = basename(argv[0] ?? '')
      return isResumableAgent(program) && parseAgentHooks(readSettingsFile().agents?.hooks)[program]
    },
    agentChanges: agentChanges.subscribe,
    tell: tellPane,
    splitTabNow: async (workspaceId, paneId) => {
      const target = workspaceCommandTarget(workspaceId)
      const res = await execCommand(target, 'pane.splitTabOf', { paneId }, true)
      return res.ok ? (res.result as { name: string | null; human: boolean }) : null
    },
    humanTab: async (workspaceId, name) => {
      const target = workspaceCommandTarget(workspaceId)
      const res = await execCommand(target, 'pane.tabPlan', { paneIds: [], tab: name }, true)
      return res.ok && typeof (res.result as { human?: unknown }).human === 'string'
    },
    paneTitle: async (paneId) => {
      const pane = getByPaneId(paneId)
      if (!pane) return undefined
      const res = await execCommand({ ...targetOf(pane), paneId: null }, 'pane.list')
      const panes = res.ok && Array.isArray(res.result) ? (res.result as PaneTitleEntry[]) : []
      return panes.find((p) => p.paneId === paneId)?.title
    },
    reach,
    interruptGraceMs: INTERRUPT_GRACE_MS,
  })
  services.processes = registry
  const peekAttention = async (to: PaneIdentity): Promise<PaneAttentionPeek> => {
    const unreported = keptAttention.peek(to.paneId)
    if (unreported) return unreported
    const res = await execCommand(targetOf(to), 'attention.peek')
    return res.ok && res.result && typeof res.result === 'object' ? res.result : {}
  }
  const paneHibernated = async (to: PaneIdentity): Promise<boolean> => {
    const res = await execCommand(targetOf(to), 'pane.hibernated')
    return res.ok && (res.result as { hibernated?: unknown } | undefined)?.hibernated === true
  }
  const paneReachDeps: PaneReachDeps = {
    processPane: async (ref, ctx) => {
      const entry = registry.resolve(ref, ctx.identity.workspaceId, await reach.visible(ctx))
      return entry && entry.status !== 'closed' ? entry.paneId : undefined
    },
    inScope: reach.inScope,
    isChild: (ownerPaneId, paneId) => registry.isChild(ownerPaneId, paneId),
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isConfined: (paneId) => ptys.get(paneId)?.sandboxed === true,
  }
  registerPaneIoMethods({
    ...paneReachDeps,
    io: paneIo,
    state: getTerminalState,
    managerAllowsInput: () => managerSettings().allowInput,
    attention: peekAttention,
    inputSent: (to) => void execCommand(targetOf(to), 'attention.typed'),
    hibernated: paneHibernated,
    wake: (to) => wakeHibernatedPane(execCommand, to),
    hibernate: (to) => execCommand(targetOf(to), 'pane.hibernate'),
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
    waking: paneWaking,
    close: (to) => execCommand(targetOf(to), 'pane.close'),
    resume: (to) => execCommand(targetOf(to), 'agent.resume'),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    hooksOn: (agent) =>
      isResumableAgent(agent) && parseAgentHooks(readSettingsFile().agents?.hooks)[agent],
  })
  registerExtensionWake({
    openedBy: (caller, paneId) => services.extensionHost?.openedBy(caller, paneId) ?? false,
    hibernated: paneHibernated,
    wake: (to) => wakeHibernatedPane(execCommand, to),
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
    waking: paneWaking,
  })
  const workspaceCommandTarget = (workspaceId: string): CommandTarget => ({
    windowId: windowForWorkspace(workspaceId) ?? '',
    workspaceId,
    paneId: null,
  })
  registerPaneMoveToMethods({
    ...paneReachDeps,
    ownerWindow: windowForWorkspace,
    paneOf: getByPaneId,
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    ensureReach: reach.ensure,
    move: (to, workspaceId) => execCommand(targetOf(to), 'pane.moveToWorkspace', { workspaceId }),
    tabPlan: (workspaceId, paneIds, tab) =>
      execCommand(workspaceCommandTarget(workspaceId), 'pane.tabPlan', { paneIds, tab }, true),
    joinTab: (workspaceId, paneIds, tab) =>
      execCommand(workspaceCommandTarget(workspaceId), 'pane.joinTab', { paneIds, tab }, true),
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
  })
  registerPaneWaitMethods({
    ...paneReachDeps,
    watch: paneWatch,
    attention: peekAttention,
    exited: (paneId) => {
      const entry = registry.forPane(paneId)
      if (entry) return entry.status === 'exited'
      return terminalState.get(paneId)?.running === false
    },
  })
  registerDocsMethods({ extensions: () => services.extensionHost?.listForAgents() ?? [] })
  registerVaultMethods({ isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId) })
  registerOpenFileMethods({
    grants: openFileGrants,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    confineFolder: (path) => resolveSafe(path, fileRoots()),
    waits: openWaits,
    execCommand,
    opened: (workspaceId, paneId, paths) => {
      const noted = paths.filter((path) => artifactProducers.note(workspaceId, paneId, path))
      if (noted.length > 0) artifactsChanged(workspaceId)
    },
  })
  registerBusMethods({
    inScope: reach.inScope,
    managerSendAllowed: () => services.managerLimiter?.busAllowed() ?? true,
    sent: () => services.telemetry?.count('agents', 'bus_message'),
    announce: (from, to, text) => {
      void announceBusMessage(
        {
          execCommand,
          listPanes: () =>
            listPanes({
              execCommand,
              getTerminalState,
              ptyPid,
              windowIds,
              waking: isWaking,
            }),
          listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
        },
        from,
        to,
        text,
      ).catch(() => {})
    },
    hibernated: paneHibernated,
  })
  const extensionStore = new ExtensionStore(join(app.getPath('userData'), 'extensions.json'))
  services.extensionHost = new ExtensionHost({
    onChanged: () => {
      services.languageServers?.refresh()
      refreshAgentPlugins()
    },
    onCrashed: (extId, builtin) =>
      services.telemetry?.error({
        source: 'extension-crashed',
        name: 'ExtensionCrashed',
        message: 'exited too often',
        ...(builtin || services.marketplaceInstallIds().includes(extId)
          ? { extension: extId }
          : {}),
      }),
    hostGrants: hostPaneGrants,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    sandboxDomains: (workspaceId) =>
      workspaceSandboxes.isEnabled(workspaceId)
        ? workspaceSandboxes.resolved(workspaceId).domains
        : null,
    roots: extensionRoots(),
    store: extensionStore,
    launches: new ExtensionLaunches(join(app.getPath('userData'), 'extension-launches.json')),
    socketPath: controlSocketPath,
    nodePath: process.execPath,
    dataDir: join(app.getPath('userData'), 'extension-data'),
    workDirForWorkspace,
    cwdForPane: (paneId) => terminalState.get(paneId)?.cwd,
    remoteCwdForPane: remoteCwdOfPane,
    agentRunning: (paneId) => agentRunning.has(paneId),
    remoteFolders: {
      windowOfWorkspace: workspaceWindowId,
      refusal: (workspaceId) =>
        scratchFolders.isScratch(workspaceId)
          ? 'scratch'
          : workspaceSandboxes.isEnabled(workspaceId)
            ? 'sandboxed'
            : null,
      confirm: (req) =>
        confirmRemoteFolder(windows.get(workspaceWindowId(req.workspaceId) ?? ''), {
          extName: req.extName,
          host: req.host,
          path: req.path,
        }),
      publish: publishRemoteFolders,
    },
    locale: readLocale,
    readExtensionSettings: () => readSettingsFile().extensionSettings,
    readAssistSettings: readSettingsFileOrNull,
    redact: redactor.redact,
    assistKeys: assistKeyStore(),
    secrets: extensionSecretStore(),
    connections: extensionConnections(),
    openAssistUiIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'assist:open-ui', req),
    broadcast,
    publishWorkspaceChips,
    openPanelIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-panel', req),
    openDiffIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-diff', req),
    openFileIn: (req) =>
      openFileForExtension(
        { grants: openFileGrants, windowOf: workspaceWindowId, execCommand },
        req,
      ),
    openTerminalIn: openTerminalInWindow,
    notify: (n) => postNotification(notifyDeps, n),
    confirm: (req) => confirmForExtension(req, windows.values()),
    notifyPanel: (n, open) => postPanelNotification(notifyDeps, n, open),
    agentArgv: (name) => managerAgents(managerSettings())[name] ?? null,
    agentNames: () => Object.keys(managerAgents(managerSettings())),
    offerToAgentIn: (offer) => agentOffers.offer(offer),
    focusPaneIn: focusPaneInWindow,
    exec: new ExtensionExec({
      workspace: (workspaceId) => {
        if (!windowForWorkspace(workspaceId)) return null
        const sandboxed = workspaceSandboxes.isEnabled(workspaceId)
        const workDir = sandboxed
          ? workspaceSandboxes.workDir(workspaceId)
          : workDirForWorkspace(workspaceId)
        return {
          workDir: expandHome(workDir ?? homedir(), homedir()),
          scratch: scratchFolders.isScratch(workspaceId),
          sandboxed,
        }
      },
      wrap: (workspaceId, command, extraReads) =>
        workspaceSandboxes.wrap(workspaceId, command, 'bash', [], extraReads),
      sandboxEnv: (workspaceId, env) => ({
        ...sandboxSpawnEnv(env),
        TMPDIR: workspaceSandboxes.tmpDir(workspaceId),
      }),
      dataDir: (extId) => join(app.getPath('userData'), 'extension-data', extId),
      baseEnv: () => process.env,
    }),
    resumeOf: async (pane) => {
      const res = await execCommand(targetOf(pane), 'pane.resumeToken')
      const resume = res.ok ? parseAgentResume((res.result as { resume?: unknown })?.resume) : null
      if (!resume) return null
      const panes = await listPanes({
        execCommand,
        getTerminalState,
        ptyPid,
        windowIds,
        waking: isWaking,
      })
      const held = panes.some(
        (p) => p.agentSessionId === resume.id && p.agent === resume.agent && !p.hibernated,
      )
      return { resume, held }
    },
  })
  refreshAgentPlugins()
  registerExtensionMethods(() => services.extensionHost)
  registerExtensionIpc(services.extensionHost)
  registerRemoteFilesIpc(services.extensionHost)
  ipcMain.on(AGENT_OFFER_RESULT_CHANNEL, (e, requestId: unknown, paneId: unknown) =>
    agentOffers.answer(String(e.sender.id), requestId, paneId),
  )
  services.languageServers = createLanguageServers()
  services.languageServers.refresh()
  registerLanguageServersIpc({
    servers: services.languageServers,
    setEnabled: (extId, serverId, enabled) =>
      services.extensionHost?.contributions.setLanguageServerEnabled(extId, serverId, enabled),
    setOverride: (key, override) => serverOverrides.choose(key, override),
  })
  const marketplace = new Marketplace({
    recordsPath: join(app.getPath('userData'), 'marketplaces.json'),
    clonesDir: join(app.getPath('userData'), 'marketplaces'),
    extensionsDir: join(configDir(), 'extensions'),
    builtinIds: () =>
      services.extensionHost
        ?.list()
        .filter((ext) => ext.builtin)
        .map((ext) => ext.id) ?? [],
    forget: (extId) => {
      managedServers.forgetExtension(extId)
      serverOverrides.forgetExtension(extId)
      extensionStore.delete(extId)
      extensionConnections().forget(extId)
      for (const secrets of [extensionSecretStore(), assistKeyStore()]) {
        for (const key of secrets.keys(extId)) secrets.set(extId, key, null)
      }
    },
    rescan: () => services.extensionHost?.processes.rescan(),
    locale: readLocale,
    official: OFFICIAL_MARKETPLACE,
  })
  registerMarketplaceIpc(marketplace)
  services.marketplaceInstallIds = () =>
    marketplace
      .syncedInstalls()
      .filter((install) => marketplaceId(install.marketplace) === officialMarketplaceId)
      .map((install) => install.id)
  services.profileSync = startProfileSync({
    userData: app.getPath('userData'),
    configDir: configDir(),
    readSettings: readSettingsFile,
    broadcast: (channel, payload) => broadcast(channel, payload),
    onSettingsPulled: () => {
      services.extensionHost?.config.reloadSettings()
      services.extensionHost?.refreshLocale()
    },
    installedExtensions: () => marketplace.syncedInstalls(),
    builtinIds: () =>
      services.extensionHost
        ?.list()
        .filter((ext) => ext.builtin)
        .map((ext) => ext.id) ?? [],
    installExtension: async (id, url) => (await marketplace.installSuggested(id, url, true)).ok,
    secretSources: () => {
      const store = (name: string) => {
        const path = storePath(name, 'global')
        return { deps: encryptedFile(path), mtime: () => statSync(path).mtimeMs }
      }
      const vault = store('vault')
      const ext = store('extension-secrets')
      const assist = store('assist-keys')
      const mcp = store('mcp-secrets')
      const logins = credentials()
      return [
        flatSource(vault.deps, vault.mtime),
        groupedSource('extensions', ext.deps, ext.mtime),
        groupedSource('assistant', assist.deps, assist.mtime),
        groupedSource('mcp', mcp.deps, mcp.mtime),
        ...(logins ? [loginsSource(logins)] : []),
      ]
    },
    protect: {
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (kept) => safeStorage.decryptString(Buffer.from(kept, 'base64')),
    },
    detectSecrets: (text) =>
      redactionScan.scan(text, parsePrivacySettings(readSettingsFile().privacy).redaction.patterns),
  })
  void services.profileSync.run()
  registerAssistIpc(() => services.extensionHost?.assistant ?? null)
  registerChatSessionIpc(
    createChatSessionStore({ dir: join(dirname(storePath('chat', 'global')), 'chat-sessions') }),
    redactor.text,
  )
  const mcpSecretsPath = storePath('mcp-secrets', 'global')
  const mcpSecrets = encryptedStore(mcpSecretsPath)
  const chatToolSettings = () => parseChatToolSettings(readSettingsFile().assistant)
  services.mcpOAuth = new McpOAuth({
    store: createMcpOAuthStore(encryptedFile(mcpSecretsPath)),
    openExternal: openExternalSafe,
    browser: mcpOAuthBrowser(app.isPackaged, process.env),
    pages: () => mainStrings().native.signIn,
    onChange: () => services.mcpHost?.notify(),
  })
  services.mcpHost = new McpHost({
    servers: () => chatToolSettings().mcpServers,
    secret: (server, key) => mcpSecrets.get(server, key),
    onStatus: (status) => broadcast('chatTools:mcp-status', status),
    auth: services.mcpOAuth,
  })
  registerChatToolsIpc({
    roots: fileRoots,
    settings: chatToolSettings,
    mcp: services.mcpHost,
    secrets: mcpSecrets,
    oauth: services.mcpOAuth,
    grants: new ChatToolGrants(join(app.getPath('userData'), 'chat-tool-grants.json')),
    onGrants: (keys) => broadcast('chatTools:always-grants', keys),
  })
  const snippetDeps: SnippetDeps = {
    userDir: join(configDir(), 'snippets'),
    roots: () => [homedir(), app.getPath('userData')],
    workDirForWorkspace,
    extensionSnippets: () => services.extensionHost?.contributions.snippets() ?? [],
  }
  registerSnippetIpc(snippetDeps)
  registerSnippetMethods(snippetDeps)
  registerCompletionIpc({
    userDir: join(configDir(), 'completions'),
    extensionDirs: () => services.extensionHost?.contributions.completionDirs() ?? [],
  })
  services.viewHost = new ViewHost({
    dir: join(configDir(), 'views'),
    store: new ViewStore(join(app.getPath('userData'), 'views.json')),
    onChange: (listing) => broadcast('views:changed', listing),
    log: (line) => console.warn(`[views] ${line}`),
  })
  registerViewsIpc(services.viewHost)
  registerViewMethods({ host: services.viewHost, execCommand })
  registerIconThemeIpc({
    themes: () => services.extensionHost?.contributions.iconThemes() ?? [],
    onError: (id, error) => console.warn(`[icon theme ${id}] ${error}`),
  })
  registerKeymapIpc({
    keymaps: () => services.extensionHost?.contributions.keymaps() ?? [],
    platform: process.platform,
    onError: (ref, error) => console.warn(`[keymap ${ref}] ${error}`),
    onSkipped: (ref, skipped) =>
      console.warn(`[keymap ${ref}] skipped entries: ${describeSkipped(skipped)}`),
  })
  registerLanguagePackIpc(languagePackDeps)
  registerEditorLanguageIpc({
    languages: () => services.extensionHost?.contributions.editorLanguages() ?? [],
    onError: (extId, error) => console.warn(`[editor language ${extId}] ${error}`),
  })
  platformEvents.on('notify', (n: { title: string; body?: string; from: string }) =>
    services.extensionHost?.events.emitEvent('notification', n),
  )
  registerSameFolder({ workDir: workDirForWorkspace, home: homedir })
  registerPaneListMethods({
    execCommand,
    getTerminalState,
    ptyPid,
    windowIds,
    waking: isWaking,
    processOf: (paneId) => {
      const entry = services.processes?.forPane(paneId)
      return entry ? processStatusOf(entry) : undefined
    },
    reach,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
  })
  registerGatewayMethods()
  const tailnet = createTailnet({
    command: tsnetHelperPath(app.getAppPath(), process.platform),
    stateDir: join(app.getPath('userData'), 'tsnet'),
    hostname: tailnetNodeName(hostname()),
    onChange: (state) => {
      onTailnetChange(state)
      broadcast('gateway:tailnet-changed', state)
    },
    log: (event, fields) => services.appLog?.info(event, fields),
  })
  configureTailnet(tailnet, { openExternal: (url) => void openExternalSafe(url) })
  services.stopTailnet = () => tailnet.stop()
  const publisher = createBonjourPublisher()
  configureAnnouncer(publisher)
  services.stopAnnouncing = publisher.unpublish
  onPairRequestsChanged(() => broadcast('gateway:pair-requests-changed', listPairRequests()))
  registerGatewayIpc()
  configureGatewayControl({
    execCommand,
    listCommandsFor,
    getTerminalState,
    listPanes: () =>
      listPanes({
        execCommand,
        getTerminalState,
        ptyPid,
        windowIds,
        waking: isWaking,
      }),
    listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
    fileScope: phoneFileScope,
    artifactsDir: (workspaceId) => artifactFolders.followed(workspaceId),
    openArtifact: async (workspaceId, path) => {
      const windowId = windowForWorkspace(workspaceId)
      if (!windowId) return false
      const res = await execCommand({ windowId, workspaceId, paneId: null }, OPEN_FILES_COMMAND, {
        files: [{ path }],
        background: true,
      })
      return res.ok
    },
    listWorkspaceGroups: () => listWorkspaceGroups({ execCommand, windowIds }),
    primaryWindowId,
    attachPhoneObserver,
    ptyResize,
    ptyWrite,
    listAsks: askHub.list,
    answerAsk: askHub.answer,
    agentRunning: (paneId) => agentRunning.has(paneId) && ptys.has(paneId),
  })
  const sharedBrowser = session.fromPartition(SHARED_BROWSER_PARTITION)
  browserAgentsOf(sharedBrowser)
  const isSharedPane = (paneId: string): boolean => browserProfiles.isShared(paneId)
  registerBrowseMethods({
    allowNavigation: (workspaceId, url) => browserFence.check(workspaceId, url),
    browserPanes,
    isSharedPane,
    execCommand,
    screenshotRoots: [homedir(), app.getPath('userData')],
    consoleBuffers,
    errorBuffers,
    reach,
  })
  registerPickMethods({ browserPanes, isSharedPane, errorBuffers, broadcast, reach })
  registerPickIpc(
    { browserPanes, isSharedPane, errorBuffers, broadcast, reach },
    reachesPane,
    redactor.text,
  )
  registerRegionIpc(browserPanes, reachesPane, redactor.text)
  registerBrowserStorageIpc((paneId, senderWindowId) =>
    ownedGuest(browserPanes, paneId, senderWindowId),
  )
  registerLoginFill({
    browserPanes,
    isSharedPane,
    ownedGuest: (paneId, senderWindowId) => ownedGuest(browserPanes, paneId, senderWindowId),
    reach,
  })
  const retiredTokens = retireLegacyScriptTokens(
    storePath('script-tokens', 'global'),
    retiredScriptTokensPath(),
  )
  if (retiredTokens.length > 0) {
    const text = mainStrings().native.scriptTokensRetired
    postNotification(notifyDeps, {
      title: fmt(text.title, { count: retiredTokens.length }),
      body: fmt(text.body, { names: retiredTokens.join(', ') }),
      from: 'script-tokens',
    })
  }
  const scriptTokenDeps = {
    path: scriptTokensPath,
    retiredPath: retiredScriptTokensPath,
    listing: workspaceListing,
    changed: () => broadcast('scriptTokens:changed', null),
    appWindows: () => windows.values(),
    usage: scriptTokenUsage,
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
  }
  registerScriptTokenMethods(scriptTokenDeps)
  registerScriptTokenIpc(scriptTokenDeps)
  setScriptTokenCheck((token) =>
    checkScriptToken({ path: scriptTokensPath(), retiredPath: retiredScriptTokensPath() }, token),
  )
  const presenceDeps = electronPresenceDeps(
    () => windows.values(),
    () => mainStrings().native.userPresence,
    process.resourcesPath,
  )
  setUserPresenceCheck(({ action, name }) =>
    verifyUserPresence(
      { reason: fmt(mainStrings().native.userPresence[action], { name }), name },
      presenceDeps,
    ),
  )
  registerControlServer({
    execCommand,
    listCommandsFor,
    getTerminalState,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    windowOfWorkspace: workspaceWindowId,
    primaryWindow: primaryWindowId,
    byAgent: reach.byAgent,
    reach,
    usage: scriptTokenUsage,
  })
  writeControlInfo(controlInfoPath(), controlSocketPath(), process.pid)
  keptPlumbing.start(keepShellsOn())
  registerManagerIpc()
  services.managerLimiter = registerManagerMethods({
    settings: managerSettings,
    agents: () => managerAgents(managerSettings()),
    io: paneIo,
    openWorker,
    paneAlive: (paneId) => getByPaneId(paneId) !== undefined,
    now: Date.now,
  })
  services.managerService = new ManagerService({
    loadResume: () => loadJson<unknown>(managerResumePath(), null),
    saveResume: (saved) => {
      if (saved) saveJson(managerResumePath(), saved)
      else rmSync(managerResumePath(), { force: true })
    },
    agents: () => managerAgents(managerSettings()),
    createPane: createManagerPane,
    spawn: spawnManagerPty,
  })
  startPortal()
  services.appTray = new AppTray({
    iconPath: appIcon,
    tooltip: PRODUCT_DISPLAY_NAME,
    text: () => mainStrings().native.tray,
    windows: () => [...windows.values()],
    quit: requestQuit,
    setBadgeCount: (count) => app.setBadgeCount(count),
  })
  startCoreBoards()
  services.globalHotkey = new GlobalHotkey(globalShortcut, toggleAllWindows)
  applyGlobalHotkey()
  services.broker = new WindowBroker({
    createWindow,
    holdPtys,
    execCommand,
    agents: agentRunning,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    reveal: showWindow,
    onList: (list) => services.appTray?.setUnread(unreadWorkspaces(list)),
  })
  services.broker.register()
  services.broker.openAll()
  services.extensionHost.processes.startEager()
  services.extensionHost.processes.watchUserExtensions()
  services.viewHost.watch()
  app.on('browser-window-focus', emitFocusChanged)
  app.on('browser-window-blur', emitFocusChanged)
  setInterval(autosaveScrollback, SCROLLBACK_AUTOSAVE_MS).unref()

  app.on('activate', revealApp)
})

const redactionScan = createWorkerScan(redactionWorkerScript(app.getAppPath()))
const redactor = createRedactor(
  () => (readSettingsFile() as { privacy?: unknown }).privacy,
  redactionScan.scan,
)
const redactScrollback = createScrollbackRedactor(redactor)
let scrollbackSaves: Promise<void> = Promise.resolve()

function persistScrollback(): Promise<void> {
  if (services.broker && !services.broker.persisting) return scrollbackSaves
  let toSave: Record<string, string>
  try {
    const byPane = pendingRestoredScrollback()
    for (const [paneId, entry] of ptys) byPane[paneId] = entry.mirror.serialize()
    toSave = scrollbackToSave(byPane, isScratchPane)
  } catch (err) {
    console.error('[workspace] scrollback save failed', err)
    return scrollbackSaves
  }
  scrollbackSaves = scrollbackSaves
    .then(async () => {
      const redacted = await redactScrollback(toSave)
      if (quit.savingScrollbackForQuit && !quit.scrollbackSavedForQuit)
        quitTrace.stage('scrollback-redacted')
      if (services.broker && !services.broker.persisting) return
      await saveScrollback(redacted)
    })
    .catch((err: unknown) => console.error('[workspace] scrollback save failed', err))
  return scrollbackSaves
}

const SCROLLBACK_AUTOSAVE_MS =
  process.env.NODE_ENV === 'test' && Number(readEnv('TEST_SCROLLBACK_AUTOSAVE_MS')) > 0
    ? Number(readEnv('TEST_SCROLLBACK_AUTOSAVE_MS'))
    : 5000
let lastScrollbackSignature = ''

function autosaveScrollback(): void {
  if (quit.savingScrollbackForQuit) return
  let signature = ''
  for (const [paneId, entry] of ptys) signature += `${paneId}:${entry.mirror.revision};`
  signature += `pending:${Object.keys(pendingRestoredScrollback()).length}`
  if (signature === lastScrollbackSignature) return
  lastScrollbackSignature = signature
  void persistScrollback()
}

const quitTrace = createQuitTrace((event, fields) => services.appLog?.info(event, fields))

function exitAtQuitDeadline(): void {
  services.appLog?.warn('quit-deadline', {
    stage: quitTrace.current(),
    totalMs: quitTrace.elapsedMs(),
    alive: summarizeKinds(process.getActiveResourcesInfo()),
  })
  app.exit(0)
}

app.on('before-quit', (event) => {
  const plan = planQuit({
    approved: quit.quitApproved,
    requestedByOstia: quitRequested,
    signaled: quitSignaled,
    platform: process.platform,
  })
  quitRequested = false
  quitTrace.stage(`plan-${plan}`)
  if (plan === 'unattended') {
    quit.quitApproved = true
    freezeAll([...windows.values()])
    exitAfterDeadline(exitAtQuitDeadline)
  }
  if (plan === 'ask') {
    event.preventDefault()
    if (quitAsking) return
    quitAsking = true
    const all = [...windows.values()]
    const kept = keptOnQuit(
      quit.restartRequested,
      confirmQuitOn(),
      [...ptys.values()].map((entry) => ({ paneId: entry.paneId, kept: entry.kept !== null })),
    )
    void confirmQuit(all, BrowserWindow.getFocusedWindow() ?? mainWindow(), {
      scratchFiles: (workspaceId) => scratchFolders.countFiles(workspaceId),
      kept: kept.kept,
      keptShells: kept.offer,
      workspacesOf: (win) => services.broker?.workspacesOf(win) ?? [],
      processes: () =>
        [...ptys.values()].map((entry) => ({
          paneId: entry.paneId,
          workspaceId: entry.workspaceId,
          ...paneActivity(entry),
        })),
      confirmNative: nativeQuitConfirm(mainStrings),
    }).then((answer) => {
      quitAsking = false
      if (answer === 'cancel') {
        quit.restartRequested = false
        return
      }
      quitAnswer = answer
      quit.quitApproved = true
      freezeAll(all)
      app.quit()
    })
    return
  }
  if (!quit.scrollbackSavedForQuit) {
    event.preventDefault()
    if (quit.savingScrollbackForQuit) return
    quit.savingScrollbackForQuit = true
    quitTrace.stage('scrollback')
    void persistScrollback().finally(() => {
      quit.scrollbackSavedForQuit = true
      app.quit()
    })
    return
  }
  if (!telemetrySentForQuit) {
    event.preventDefault()
    if (sendingTelemetryForQuit) return
    sendingTelemetryForQuit = true
    quitTrace.stage('telemetry')
    void (services.telemetry?.shutdown() ?? Promise.resolve()).finally(() => {
      telemetrySentForQuit = true
      app.quit()
    })
    return
  }
  quitTrace.stage('teardown-windows')
  services.broker?.persist()
  services.managerService?.shutdown()
  services.appLog?.info('app-quit', { ptys: ptys.size })
  const keepingShells = keepsShellsOnQuit(quit.restartRequested, quitAnswer)
  services.appLog?.info('quit-kept-shells', {
    keep: keepingShells ? 1 : 0,
    restart: quit.restartRequested ? 1 : 0,
  })
  if (keepingShells) {
    for (const workspaceId of keptHostPanes.keys()) {
      syncKeptExposed(workspaceId, portForwarder.listeners(workspaceId))
    }
  }
  quitTrace.stage('teardown-ptys')
  for (const entry of ptys.values()) {
    entry.mirror.dispose()
    if (keepingShells && entry.kept) {
      entry.kept.detach()
      entry.portBridge?.close()
      continue
    }
    try {
      entry.pty.kill()
    } catch {}
    removeStateFile(entry)
  }
  ptys.clear()
  quitTrace.stage('teardown-kept-shells')
  if (keepingShells) keptShells.release()
  else keptShells.quitNow()
  quitTrace.stage('teardown-language-servers')
  services.languageServers?.stopAll()
  languageServerWatches.closeAll()
  quitTrace.stage('teardown-sandboxes')
  if (keepingShells) workspaceSandboxes.releaseAll()
  else workspaceSandboxes.stopAll()
  workspaceAgents.stopAll()
  for (const workspaceId of scratchFolders.workspaceIds()) workspaceSandboxes.forget(workspaceId)
  workspaceSandboxes.clearTmp(!keepingShells)
  artifactFolders.dispose()
  artifactHistory.quit()
  artifactHistory.dispose()
  previews.dispose()
  scratchFolders.removeAll()
  quitTrace.stage('teardown-hosts')
  portForwarder.stopAll()
  services.gitService?.stop()
  services.portsService?.stop()
  services.extensionHost?.processes.stopAll()
  services.mcpOAuth?.closeAll()
  services.mcpHost?.closeAll()
  services.viewHost?.stop()
  services.profileSync?.stop()
  quitTrace.stage('teardown-network')
  stopControlServer()
  clearControlInfo(controlInfoPath(), controlSocketPath())
  services.portal?.stop()
  void services.stopTailnet?.()
  services.stopAnnouncing?.()
  void stopGateway()
  services.appTray?.remove()
  services.globalHotkey?.clear()
  if (quit.stagedUpdate) {
    quitTrace.stage('update-swap')
    const { pending, sweepFile } = quit.stagedUpdate
    quit.stagedUpdate = null
    const result = swapStagedBundle(pending.appDir, {
      verify: (staged) => verifyStagedSync(staged, updatePolicy),
    })
    services.appLog?.info('update-swap', { version: pending.version, result })
    if (result === 'swapped') saveJson(sweepFile, pending)
  }
  quitTrace.stage('teardown-done')
})

app.on('will-quit', () => {
  quitTrace.stage('will-quit')
  scriptTokenUsage.close()
})
app.on('quit', () => quitTrace.stage('quit'))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') requestQuit()
})
