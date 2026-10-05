import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BrowserWindow,
  app,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeTheme,
  safeStorage,
  session,
  shell,
  webContents,
} from 'electron'
import type { IPty } from 'node-pty'
import appIcon from '../../resources/icon.png?asset'
import type { AgentResume } from '../shared/agentResume'
import { appEnv } from '../shared/appEnv'
import { SHARED_BROWSER_PARTITION, browserPartition } from '../shared/browserProfile'
import { MANAGER_CAPABILITIES } from '../shared/capabilities'
import { parseChatToolSettings } from '../shared/chatTools'
import { languageForPath } from '../shared/editorLanguages'
import { EXTENSION_SUGGESTIONS } from '../shared/extensionSuggestions'
import type { ExtensionPanelContext, ExtensionResult, WorkspaceChip } from '../shared/extensions'
import { languageServerKey } from '../shared/languageServers'
import { MANAGER_FEATURE, managerAgents, parseManagerSettings } from '../shared/managerSettings'
import { OPEN_FILES_MAX } from '../shared/openFiles'
import { OFFICIAL_MARKETPLACE, PRODUCT_NAME } from '../shared/product'
import { PRODUCT_DISPLAY_NAME } from '../shared/productDisplay'
import { type RemoteCwd, normalizeRemoteCwd } from '../shared/remoteFolders'
import { parseSandboxGlobals } from '../shared/sandbox'
import { quoteArgv } from '../shared/shellQuote'
import { shellArgv, shellName } from '../shared/terminalShell'
import type {
  AppInfo,
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  ExternalEditorRequest,
  FsEntry,
  FsKind,
  LifecycleEvent,
  PromptContext,
  PromptContextRequest,
  PtyAttachResult,
  PtySpawnOptions,
  TerminalStateSnapshot,
  WindowBounds,
} from '../shared/types'
import { clampZoom, zoomFactor } from '../shared/zoom'
import { AGENT_OFFER_RESULT_CHANNEL, createAgentOfferRelay } from './agentOfferRelay'
import { AgentRunningPanes } from './agentRunning'
import { agentPluginContent } from './agentSkills'
import { registerAgentTranscriptIpc } from './agentTranscript'
import { type AppLog, LOG_FILE_NAME, createAppLog } from './appLog'
import { installAppMenu } from './appMenu'
import { registerAppUpdate } from './appUpdate'
import { approvals, registerApprovals } from './approvals'
import { registerAssistIpc } from './assistIpc'
import { registerAttentionMethods } from './attention'
import {
  type ConsoleEntry,
  OSTIA_ERROR_PREFIX,
  PAGE_ERROR_CATCHER_JS,
  clearGuestBrowseState,
  consoleLevelName,
  ownedGuest,
  pushConsoleEntry,
  registerBrowseMethods,
} from './browse'
import { cancelPick, registerPickIpc, registerPickMethods } from './browsePick'
import { registerRegionIpc } from './browseRegion'
import { BrowserProfiles } from './browserProfiles'
import { registerBrowserStorageIpc } from './browserStorage'
import { browserUserAgent } from './browserUserAgent'
import { registerBusMethods } from './bus'
import { announceBusMessage } from './busNotice'
import { dropIdentity, setCaps } from './capabilityStore'
import { createChatSessionStore } from './chatSessions'
import { registerChatSessionIpc } from './chatSessionsIpc'
import { registerChatToolsIpc } from './chatToolsIpc'
import { type ClipboardEdits, registerClipboardEdits } from './clipboardEdits'
import { confirmQuit, freezeAll, registerCloseGuard } from './closeGuard'
import { registerCompletionIpc } from './completionSpecs'
import { attachContextMenu } from './contextMenu'
import { connHasCap, setCapFilter } from './controlAuth'
import { controlSocketPath, registerControlServer, stopControlServer } from './controlServer'
import { registerCredentials } from './credentials'
import { type Diagnostics, registerDiagnostics } from './diagnostics'
import { registerDocsMethods } from './docs'
import { registerEditorLanguageIpc } from './editorLanguages'
import { emitPlatformEvent, emitSessionState, platformEvents } from './events'
import { confirmForExtension } from './extensionConfirm'
import { ExtensionHost, type TerminalOpenRequest, registerExtensionMethods } from './extensionHost'
import type { ExtensionRoot } from './extensionManifest'
import { type SecretStoreDeps, createSecretStore } from './extensionSecrets'
import { ExtensionStore } from './extensionStore'
import { DismissedSuggestions, suggestionFor } from './extensionSuggestions'
import { openInExternalEditor } from './externalEditor'
import { FileWatches, TreeWatches } from './fileWatch'
import { readBinaryConfined } from './fsBinary'
import { registerGatewayIpc, registerGatewayMethods } from './gateway'
import { configureGatewayControl, stopGateway } from './gateway/server'
import { GlobalHotkey, toggleWindows } from './globalHotkey'
import { type GuestChords, registerGuestChords } from './guestChords'
import { clearGuestNetwork, watchGuestNetwork } from './guestNetwork'
import { registerIconThemeIpc } from './iconThemes'
import {
  type PaneIdentity,
  getByPaneId,
  markManager,
  panesOwnedBy,
  registerPane,
  rehomeWorkspace,
  removePane,
  removeWindow,
  resolveExternal,
  windowOfWorkspace,
  workspaceHasManager,
} from './idRegistry'
import { loadJson, saveJson, storePath } from './jsonStore'
import { describeSkipped, registerKeymapIpc } from './keymaps'
import { registerLanguagePackIpc } from './languagePacks'
import { LanguageServers, scrubbedEnv } from './languageServers'
import { registerLanguageServersIpc } from './languageServersIpc'
import { atLocalPrompt } from './localPrompt'
import { registerLoginFill } from './loginFill'
import { ManagedServers, downloadBaseUrl } from './managedServers'
import { ManagerService, managerWindowId } from './manager'
import { managerArgv, writeManagerClaudePlugin, writeManagerCodexContext } from './managerAgent'
import { type ManagerLimiter, registerManagerMethods } from './managerMethods'
import { Marketplace, marketplaceId, normalizeMarketplaceUrl } from './marketplace'
import { McpHost } from './mcpHost'
import { McpOAuth, mcpOAuthBrowser } from './mcpOAuth'
import { createMcpOAuthStore } from './mcpOAuthStore'
import {
  postActionNotification,
  postNotification,
  postPanelNotification,
  registerNotifyIpc,
  registerNotifyMethods,
} from './notify'
import { OpenFileGrants } from './openFileGrants'
import { registerOpenFileMethods } from './openFileMethods'
import { registerOpenPathIpc } from './openPath'
import type { OriginReach } from './originAgents'
import { type PaneIo, registerPaneIoMethods } from './paneIo'
import { listPanes, listWorkspaces, registerPaneListMethods } from './paneList'
import { registerPaneResumeMethods } from './paneResume'
import { resolveSafe } from './pathGuard'
import {
  type MirrorHandle,
  type MirrorSink,
  Portal,
  portalSocketPath,
  portalSupported,
} from './portal'
import { callerVerdict, procFs, ttysOf } from './portalCaller'
import { acceptsPrimarySelection } from './primarySelection'
import { registerPrivacyIpc } from './privacyIpc'
import { privateTmpDir } from './privateTmp'
import { INTERRUPT_GRACE_MS, type ProcessRegistry, registerProcessMethods } from './processManager'
import { registerProjectRootIpc } from './projectRoot'
import { KubeContextReader, NodeVersionResolver, promptContext } from './promptContext'
import { type ReapReason, RecoveryBook, orphanVerdict, planRecovery } from './ptyReaper'
import { PtySession, type SubscriberRole } from './ptySession'
import { questions, registerQuestions } from './questions'
import { exitAfterDeadline, planQuit } from './quitPlan'
import { createRedactor, createScrollbackRedactor } from './redaction'
import { createWorkerScan, redactionWorkerScript } from './redactionScan'
import { registerReleaseCheck, releaseUserAgent } from './releaseCheck'
import { confirmRemoteFolder, registerRemoteFolderConfirm } from './remoteFolderConfirm'
import type { RemoteFolders } from './remoteFolders'
import { attachWorkspace } from './sandbox/attachWorkspace'
import { BrowserFence } from './sandbox/browserFence'
import { registerSandboxMethods } from './sandbox/controlMethods'
import { DomainRequests } from './sandbox/domainRequests'
import { HostPaneGrants } from './sandbox/hostPanes'
import { registerSandboxIpc } from './sandbox/ipc'
import { packageCooldownEnv } from './sandbox/packageEnv'
import { PackageRequests } from './sandbox/packageRequests'
import { PortBridge, bridgesPorts } from './sandbox/portBridge'
import { PortForwarder, type SandboxPane } from './sandbox/portForwarder'
import { PortRequests } from './sandbox/portRequests'
import {
  needsPtyRelay,
  relayForced,
  sandboxedShellCommand,
  wrapForTerminal,
} from './sandbox/ptyWrap'
import { hiddenHomeNotice, sandboxFailureBanner } from './sandbox/spawnBanner'
import { sandboxSpawnEnv } from './sandbox/spawnEnv'
import { reportSandboxSpawnFailure } from './sandbox/spawnFailureNotice'
import { reachableContainerSockets, srtVendorDir } from './sandbox/srtConfig'
import { SandboxStore } from './sandbox/store'
import { ViolationLog, recordViolations } from './sandbox/violations'
import {
  type SandboxReadRules,
  sandboxEntries,
  sandboxPath,
  visibleInSandbox,
} from './sandbox/visibility'
import { SandboxUnavailableError, WorkspaceSandboxes } from './sandbox/workspaceSandboxes'
import { ScratchFolders, registerScratchIpc } from './scratchFolders'
import { ScreenMirror } from './screenMirror'
import { registerSecretMethods } from './secrets/register'
import { prepareSecrets } from './secrets/secretInjection'
import { SecretService } from './secrets/secretService'
import { WorkspaceAgents } from './secrets/workspaceAgents'
import { registerSelectionIpc } from './selectionReport'
import { ServerOverrides } from './serverOverrides'
import { type SettingsSyncHandle, startSettingsSync } from './settingsSyncIpc'
import { ExecutableIndex, commandNames, readShellState } from './shellCommands'
import { closesPaneOnExit } from './shellExit'
import { INTEGRATION_DIR, setAgentPlugins, shellIntegrationSpawnOptions } from './shellIntegration'
import {
  SANDBOX_FEATURE,
  installHint,
  missingRequirements,
  onPath,
  programPath,
  registerRequirements,
  requirementLabel,
} from './systemRequirements'
import { registerSystemRequirementsIpc } from './systemRequirementsIpc'
import { PTY_COLOR_ENV, PTY_TERM_NAME, paneShellEnv } from './terminalType'
import { AppTray, closeAction, isHiddenLaunch, readCloseToTray, unreadWorkspaces } from './tray'
import { OLD_PRODUCT_NAME, appConfigDir, configHome, dataHome } from './userDirs'
import {
  deleteGlobalVaultValue,
  registerVaultMethods,
  setGlobalVaultValue,
  vaultKeys,
  vaultValue,
} from './vault'
import { ViewHost, ViewStore } from './viewHost'
import { registerViewMethods, registerViewsIpc } from './viewsIpc'
import { MAIN_SLOT } from './windowBook'
import { WindowBroker } from './windowBroker'
import { type WorkflowDeps, registerWorkflowIpc, registerWorkflowMethods } from './workflows'
import { firstKnownOwner, workspaceChipsForWindow } from './workspaceChips'
import { registerWorkspaceMergeIpc } from './workspaceMerge'
import {
  removeWorkspace,
  setWorkspaceWorkDir,
  windowForWorkspace,
  workDirForWorkspace,
} from './workspaceRegistry'
import {
  dropRestoredScrollback,
  loadRestoredScrollback,
  pendingRestoredScrollback,
  saveScrollback,
  scrollbackToSave,
  stashScrollback,
  takeRestoredScrollback,
} from './workspaceSnapshot'

const devServerUrl = process.env.ELECTRON_RENDERER_URL

let ptyModule: typeof import('node-pty') | null | undefined
function loadPty(): typeof import('node-pty') | null {
  if (ptyModule === undefined) {
    try {
      ptyModule = require('node-pty')
    } catch (err) {
      console.error('[pty] node-pty unavailable — terminals disabled. Run: npm run rebuild', err)
      ptyModule = null
    }
  }
  return ptyModule ?? null
}

interface PtyEntry {
  paneId: string
  pty: IPty
  session: PtySession
  mirror: ScreenMirror
  subs: Map<string, Electron.WebContents>
  killTimer: ReturnType<typeof setTimeout> | null
  spawnPath: string
  stateFile: string
  workspaceId: string
  sandboxed: boolean
  shell: string
  sandboxStamp: string | null
  portBridge: PortBridge | null
  confinedBy: string | null
  keepAlive: boolean
  exitListeners: Set<(code: number) => void>
}

const ptys = new Map<string, PtyEntry>()
const PTY_BUFFER_CAP = 1_000_000
const executables = new ExecutableIndex()
const promptSources = { node: new NodeVersionResolver(), kube: new KubeContextReader() }

function listDir(dir: string): FsEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  } catch {
    return []
  }
}

function holdsLocalPrompt(entry: PtyEntry): boolean {
  return atLocalPrompt({
    foreground: entry.pty.process,
    shell: entry.shell,
    sandboxed: entry.sandboxed,
  })
}

function sandboxReadRules(entry: PtyEntry): SandboxReadRules | null {
  if (!entry.sandboxed) return null
  try {
    const { denyRead, allowRead } = workspaceSandboxes.config(entry.workspaceId).filesystem
    return { denyRead, allowRead: allowRead ?? [] }
  } catch {
    return { denyRead: ['/'], allowRead: [] }
  }
}

function removeStateFile(entry: PtyEntry): void {
  rmSync(entry.stateFile, { force: true })
}

const RESTORE_SEAM = '\x1b]133;D\x07\r\n\x1b[2m── workspace restored ──\x1b[0m\r\n'
const HIBERNATE_SEAM = '\x1b]133;D\x07\r\n\x1b[2m── woke from hibernation ──\x1b[0m\r\n'

const hibernatedPanes = new Set<string>()
const movingPanes = new Set<string>()

const recovery = new RecoveryBook()
const recoveryHeld = new Set<string>()
const closedPanes = new Set<string>()
let appLog: AppLog | null = null
let diagnostics: Diagnostics | null = null
let processes: ProcessRegistry | null = null

function windowOfPane(paneId: string): string | undefined {
  return getByPaneId(paneId)?.windowId
}

function scheduleReap(paneId: string, entry: PtyEntry): void {
  if (entry.killTimer) clearTimeout(entry.killTimer)
  entry.killTimer = setTimeout(
    () => reapIfOrphaned(paneId, entry),
    recovery.graceFor(windowOfPane(paneId)),
  )
}

function reapIfOrphaned(paneId: string, entry: PtyEntry): void {
  entry.killTimer = null
  const verdict = orphanVerdict({
    current: ptys.get(paneId) === entry,
    owners: entry.session.ownerCount,
    moving: movingPanes.has(paneId) || entry.keepAlive,
    held: recoveryHeld.has(paneId),
    recovering: recovery.isRecovering(windowOfPane(paneId)),
  })
  if (verdict === 'wait') scheduleReap(paneId, entry)
  else if (verdict === 'reap') killPty(paneId, closedPanes.has(paneId) ? 'closed' : 'grace-expired')
}

function startRecovery(windowId: string, reason: string): void {
  recovery.start(windowId)
  appLog?.info('window-recovering', { window: windowId, reason })
  for (const [paneId, entry] of ptys) {
    if (entry.killTimer && windowOfPane(paneId) === windowId) scheduleReap(paneId, entry)
  }
}

function finishRecovery(windowId: string, livePaneIds: Set<string>): void {
  if (!recovery.end(windowId)) return
  const windowPtys = [...ptys]
    .filter(([paneId, entry]) => !entry.keepAlive && windowOfPane(paneId) === windowId)
    .map(([paneId, entry]) => ({ paneId, owners: entry.session.ownerCount }))
  const { hold, reap } = planRecovery(windowPtys, livePaneIds)
  for (const paneId of hold) {
    const entry = ptys.get(paneId)
    if (entry?.killTimer) clearTimeout(entry.killTimer)
    if (entry) entry.killTimer = null
    recoveryHeld.add(paneId)
  }
  for (const paneId of reap) killPty(paneId, 'closed')
  appLog?.info('window-recovered', { window: windowId, held: hold.length, reaped: reap.length })
}

function releaseWindowPtys(windowId: string): void {
  recovery.end(windowId)
  for (const paneId of [...recoveryHeld]) {
    if (windowOfPane(paneId) !== windowId) continue
    recoveryHeld.delete(paneId)
    const entry = ptys.get(paneId)
    if (entry && entry.session.ownerCount === 0) scheduleReap(paneId, entry)
  }
}

function holdPtys(paneIds: readonly string[]): void {
  for (const paneId of paneIds) {
    const entry = ptys.get(paneId)
    if (!entry) continue
    movingPanes.add(paneId)
    if (entry.killTimer) {
      clearTimeout(entry.killTimer)
      entry.killTimer = null
    }
  }
}

function releaseMovingPane(paneId: string): void {
  if (!movingPanes.delete(paneId)) return
  const entry = ptys.get(paneId)
  if (entry && entry.session.ownerCount === 0) killPty(paneId, 'closed')
}

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

function openExternalSafe(url: string): boolean {
  let scheme: string
  try {
    scheme = new URL(url).protocol
  } catch {
    return false
  }
  if (!EXTERNAL_SCHEMES.has(scheme)) return false
  void shell.openExternal(url)
  return true
}

function killPty(paneId: string, reason: ReapReason): void {
  const entry = ptys.get(paneId)
  if (!entry) return
  appLog?.info('pty-reap', { pane: paneId, reason })
  recoveryHeld.delete(paneId)
  closedPanes.delete(paneId)
  if (entry.killTimer) clearTimeout(entry.killTimer)
  try {
    entry.pty.kill()
  } catch {}
  entry.mirror.dispose()
  removeStateFile(entry)
  ptys.delete(paneId)
}

function hibernatePty(paneId: string): boolean {
  const entry = ptys.get(paneId)
  if (!entry) return false
  stashScrollback(paneId, entry.mirror.serialize())
  hibernatedPanes.add(paneId)
  entry.subs.clear()
  killPty(paneId, 'hibernated')
  terminalState.delete(paneId)
  return true
}

function ptyPid(paneId: string): number | undefined {
  return ptys.get(paneId)?.pty.pid
}

function feedPty(entry: PtyEntry, data: string): void {
  entry.session.push(data)
  entry.mirror.write(data)
  processes?.feed(entry.paneId, data, entry.session.cursor)
}

const paneIo: PaneIo = {
  read: async (paneId, lines) => {
    const entry = ptys.get(paneId)
    return entry ? entry.mirror.screenText(lines) : null
  },
  write: (paneId, data) => {
    const entry = ptys.get(paneId)
    if (!entry) return false
    entry.pty.write(data)
    return true
  },
}

function resizePty(entry: PtyEntry | undefined, cols: number, rows: number): void {
  if (!entry) return
  const c = cols || 80
  const r = rows || 24
  try {
    entry.pty.resize(c, r)
  } catch {
    return
  }
  entry.mirror.resize(c, r)
}

function expandHome(p: string): string {
  const home = homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

function resolveCwd(cwd?: string): string {
  const home = homedir()
  const p = expandHome(cwd ?? home)
  try {
    if (statSync(p).isDirectory()) return p
  } catch {}
  return home
}

function sandboxCwd(cwd: string, workDir: string | undefined): string {
  if (!workDir) return cwd
  return cwd === workDir || cwd.startsWith(`${workDir}/`) ? cwd : workDir
}

const scratchFolders = new ScratchFolders(privateTmpDir(`${PRODUCT_NAME}-scratch`))

function fileRoots(): string[] {
  return [homedir(), app.getPath('userData'), scratchFolders.root]
}

const openFileGrants = new OpenFileGrants({
  roots: fileRoots,
  file: join(app.getPath('userData'), 'opened-files.json'),
})

function isScratchPane(paneId: string): boolean {
  return scratchFolders.isScratch(getByPaneId(paneId)?.workspaceId)
}

const workspaceSandboxes: WorkspaceSandboxes = new WorkspaceSandboxes({
  store: new SandboxStore(join(app.getPath('userData'), 'sandbox.json')),
  globals: () => parseSandboxGlobals((readSettingsFile() as { sandbox?: unknown }).sandbox),
  basePaths: () => ({
    home: homedir(),
    dataDirs: [
      app.getPath('userData'),
      dirname(storePath('workspaces', 'global')),
      ...[
        join(app.getPath('appData'), OLD_PRODUCT_NAME),
        join(configHome(), OLD_PRODUCT_NAME),
        join(dataHome(), OLD_PRODUCT_NAME),
      ].filter((dir) => existsSync(dir)),
    ],
    runtimeDir: process.env.XDG_RUNTIME_DIR,
    agentSockets: process.env.SSH_AUTH_SOCK ? [process.env.SSH_AUTH_SOCK] : [],
    containerSockets: reachableContainerSockets(),
    socketPath: controlSocketPath(),
    srtVendorDir: srtVendorDir(app.getAppPath()),
    runtimeReads: [
      INTEGRATION_DIR,
      privateTmpDir(`${PRODUCT_NAME}-shell-state`),
      app.getAppPath(),
      dirname(process.execPath),
    ],
  }),
  workDir: (workspaceId) => workDirForWorkspace(workspaceId),
  tmpRoot: privateTmpDir(`${PRODUCT_NAME}-sbx`),
  nodePath: process.execPath,
  hostScript: join(app.getAppPath(), 'out/sandbox/host.mjs'),
  onAsk: (workspaceId, host, port) =>
    domainRequests.onBlocked(workspaceSandboxes.owner(workspaceId), host, port),
  onPackageBlocked: (workspaceId, pkg, reason) =>
    packageRequests.blocked(workspaceSandboxes.owner(workspaceId), pkg, reason),
  onViolations: (workspaceId, lines) =>
    recordViolations(
      sandboxViolations,
      (path) => workspaceSandboxes.writeRefusal(workspaceId, path),
      workspaceSandboxes.owner(workspaceId),
      lines,
    ),
})

const sandboxViolations = new ViolationLog()

let languageServers: LanguageServers | null = null

function editorLanguageOf(path: string): string {
  return languageForPath(
    path,
    (extensionHost?.editorLanguages() ?? []).map((source) => source.language),
  )
}

const managedServers = new ManagedServers({
  dir: join(app.getPath('userData'), 'language-servers'),
  userAgent: releaseUserAgent(app.getVersion()),
  findProgram: (program) => programPath(program),
  env: () => scrubbedEnv(process.env),
  baseUrl: downloadBaseUrl(app.isPackaged, process.env),
})

function sandboxCanRead(workspaceId: string, path: string): boolean {
  try {
    const { denyRead, allowRead } = workspaceSandboxes.config(workspaceId).filesystem
    return visibleInSandbox(path, { denyRead, allowRead: allowRead ?? [] })
  } catch {
    return false
  }
}

const LANGUAGE_SERVER_WATCH_DEBOUNCE_MS = 300
const languageServerWatches = new TreeWatches({
  confine: (dir) => resolveSafe(dir, fileRoots()),
  debounceMs: LANGUAGE_SERVER_WATCH_DEBOUNCE_MS,
})

const serverOverrides = new ServerOverrides(
  join(app.getPath('userData'), 'language-server-programs.json'),
)

function createLanguageServers(): LanguageServers {
  return new LanguageServers({
    watchTree: (root, onChange) => languageServerWatches.watch(root, onChange),
    sources: () =>
      (extensionHost?.languageServers() ?? []).map((source) => {
        const override = serverOverrides.get(languageServerKey(source.extId, source.server.id))
        return override ? { ...source, override } : source
      }),
    nodePath: process.execPath,
    env: () => process.env,
    pane: (paneId) => getByPaneId(paneId),
    confine: (path) => openFileGrants.confine(path),
    workDir: (workspaceId) => workDirForWorkspace(workspaceId),
    roots: fileRoots,
    sandbox: {
      owner: (workspaceId) =>
        workspaceId !== '' && workspaceSandboxes.isEnabled(workspaceId)
          ? workspaceSandboxes.owner(workspaceId)
          : null,
      readable: sandboxCanRead,
      wrap: (workspaceId, command, extraReads) =>
        workspaceSandboxes.wrap(workspaceId, command, 'bash', [], extraReads),
      env: (workspaceId, env) => ({
        ...sandboxSpawnEnv(env as Record<string, string>),
        TMPDIR: workspaceSandboxes.tmpDir(workspaceId),
      }),
    },
    findProgram: (program) => programPath(program),
    languageOf: editorLanguageOf,
    managed: managedServers,
    registerRequirements,
    post: (windowId, channel, ...args) => {
      const win = windows.get(windowId)
      if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
    },
    changed: (list) => broadcast('lsp:servers-changed', list),
    log: (event, fields) => appLog?.info(event, fields),
  })
}

function paneForWorkspace(workspaceId: string): string | undefined {
  for (const [paneId, entry] of ptys) {
    if (entry.workspaceId === workspaceId && entry.sandboxed) return paneId
  }
  return undefined
}

const domainRequests: DomainRequests = new DomainRequests({
  isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
  blockedDomains: (workspaceId) => workspaceSandboxes.resolved(workspaceId).deniedDomains,
  ask: async ({ workspaceId, paneId, host, origin }) => {
    const pane = paneId ? getByPaneId(paneId) : undefined
    const identity = pane ?? getByPaneId(paneForWorkspace(workspaceId) ?? '')
    const queue = approvals()
    if (!identity || !queue) return 'deny'
    return queue.request({
      externalId: identity.externalId,
      windowId: identity.windowId,
      paneId: identity.paneId,
      workspaceId,
      caps: [],
      kind: 'sandbox-domain',
      subject: host,
      action: origin === 'agent' ? `ostia sandbox request-domain ${host}` : `connect to ${host}`,
      detail: '',
    })
  },
  allowWorkspace: (workspaceId, domain) => {
    workspaceSandboxes.update(workspaceId, (current) => ({
      ...current,
      domains: current.domains.includes(domain) ? current.domains : [...current.domains, domain],
    }))
  },
  allowUntilRestart: (workspaceId, domain) =>
    workspaceSandboxes.allowUntilRestart(workspaceId, domain),
  now: Date.now,
})

let onSandboxSpawnFailure: ((workspaceId: string, errors: string[]) => void) | null = null

function sandboxedPanes(workspaceId: string): SandboxPane[] {
  const panes: SandboxPane[] = []
  for (const entry of ptys.values()) {
    if (entry.workspaceId === workspaceId && entry.sandboxed) {
      panes.push({ pid: entry.pty.pid, bridge: entry.portBridge })
    }
  }
  return panes
}

const portForwarder = new PortForwarder({
  panesOf: sandboxedPanes,
  unixSocketsOff: (workspaceId) => !workspaceSandboxes.resolved(workspaceId).switches.unixSockets,
})

const PACKAGE_BATCH_MS = 600

const packageRequests: PackageRequests = new PackageRequests({
  batchMs: PACKAGE_BATCH_MS,
  ask: async ({ workspaceId, kind, packages }) => {
    const identity = getByPaneId(paneForWorkspace(workspaceId) ?? '')
    const queue = approvals()
    if (!identity || !queue) return 'deny'
    const names = packages.map((p) => `${p.ref.name}@${p.ref.version}`)
    return queue.request({
      externalId: identity.externalId,
      windowId: identity.windowId,
      paneId: identity.paneId,
      workspaceId,
      caps: [],
      kind,
      subject: names.join(', '),
      action: `install ${names.length} package${names.length === 1 ? '' : 's'}`,
      detail: packages
        .map((p) => `${p.ref.ecosystem} ${p.ref.name}@${p.ref.version}: ${p.reason}`)
        .join('\n'),
    })
  },
  allowWorkspace: (workspaceId, key) => workspaceSandboxes.allowPackage(workspaceId, key, true),
  allowUntilRestart: (workspaceId, key) => workspaceSandboxes.allowPackage(workspaceId, key, false),
})

const portRequests: PortRequests = new PortRequests({
  platform: process.platform,
  isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
  policy: (workspaceId) => workspaceSandboxes.resolved(workspaceId).portsPolicy,
  ask: async ({ workspaceId, paneId, port, process: owner, origin }) => {
    const pane = paneId ? getByPaneId(paneId) : undefined
    const identity = pane ?? getByPaneId(paneForWorkspace(workspaceId) ?? '')
    const queue = approvals()
    if (!identity || !queue) return 'deny'
    return queue.request({
      externalId: identity.externalId,
      windowId: identity.windowId,
      paneId: identity.paneId,
      workspaceId,
      caps: [],
      kind: 'sandbox-port',
      subject: String(port),
      action:
        origin === 'agent' ? `ostia sandbox expose ${port}` : `a server started on port ${port}`,
      detail: owner ?? '',
    })
  },
  forwarder: portForwarder,
})

const PORT_SCAN_MS = 3000

const HOST_GRANT_TTL_MS = 120_000
const hostPaneGrants = new HostPaneGrants({ now: Date.now, ttlMs: HOST_GRANT_TTL_MS })

function scanSandboxPorts(): void {
  const workspaces = new Set<string>()
  for (const entry of ptys.values()) if (entry.sandboxed) workspaces.add(entry.workspaceId)
  for (const workspaceId of workspaces) void portRequests.scan(workspaceId)
}

const GH_TOKEN_TTL_MS = 60_000
let ghTokenCache: { at: number; value: string | null } | null = null

function ghToken(): string | null {
  if (ghTokenCache && Date.now() - ghTokenCache.at < GH_TOKEN_TTL_MS) return ghTokenCache.value
  let value: string | null = null
  if (onPath('gh')) {
    try {
      value =
        execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 3000 }).trim() || null
    } catch {
      value = null
    }
  }
  ghTokenCache = { at: Date.now(), value }
  return value
}

const secretService: SecretService = new SecretService({
  home: homedir,
  env: () => process.env,
  ghToken,
  vault: {
    list: (workspaceId) => [
      ...vaultKeys('global', workspaceId).map((key) => ({ key, scope: 'global' as const })),
      ...vaultKeys('project', workspaceId).map((key) => ({ key, scope: 'project' as const })),
    ],
    get: (key, scope, workspaceId) => vaultValue(key, scope, workspaceId),
  },
  grantedIds: (workspaceId) =>
    (workspaceSandboxes.settings(workspaceId).secrets ?? []).map((g) => g.id),
  ask: async ({ workspaceId, paneId, name, reason }) => {
    const identity = getByPaneId(paneId) ?? getByPaneId(paneForWorkspace(workspaceId) ?? '')
    const queue = approvals()
    if (!identity || !queue) return 'deny'
    return queue.request({
      externalId: identity.externalId,
      windowId: identity.windowId,
      paneId: identity.paneId,
      workspaceId,
      caps: [],
      kind: 'secret',
      subject: name,
      action: `ostia secret get ${name}`,
      detail: reason,
    })
  },
})

const workspaceAgents = new WorkspaceAgents()

async function injectSecrets(
  workspaceId: string,
): Promise<{ env: Record<string, string>; notice: string }> {
  const grants = workspaceSandboxes.settings(workspaceId).secrets ?? []
  if (grants.length === 0) return { env: {}, notice: '' }
  const dir = join(workspaceSandboxes.tmpDir(workspaceId), 'secrets')
  const prepared = prepareSecrets({
    grants,
    list: secretService.list(workspaceId),
    value: (id) => secretService.value(workspaceId, id),
    dir,
  })
  const env = { ...prepared.env }
  try {
    const socket = await workspaceAgents.ensure(
      workspaceId,
      workspaceSandboxes.sshAgentSocket(workspaceId),
      prepared.sshKeys,
    )
    if (socket) env.SSH_AUTH_SOCK = socket
  } catch {
    prepared.missing.push('ssh-agent')
  }
  const notice =
    prepared.missing.length > 0
      ? `\x1b[33m Granted secrets not found: ${prepared.missing.join(', ')}\x1b[0m\r\n`
      : ''
  return { env, notice }
}

const browserProfiles = new BrowserProfiles({
  ownerOf: (paneId) => {
    const identity = getByPaneId(paneId)
    return identity ? { windowId: identity.windowId, workspaceId: identity.workspaceId } : null
  },
  isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
  isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
})

const browserFence = new BrowserFence({
  policy: (workspaceId) => {
    if (!workspaceId || !workspaceSandboxes.isEnabled(workspaceId)) return null
    const resolved = workspaceSandboxes.resolved(workspaceId)
    return {
      browser: resolved.controls.browser,
      domains: resolved.domains,
      denied: resolved.deniedDomains,
    }
  },
  requestDomain: async (workspaceId, host) =>
    (await domainRequests.request(workspaceId, '', host)).ok,
})

setCapFilter((conn, cap) => {
  if (cap !== 'all-workspaces') return true
  const workspaceId = resolveExternal(conn.externalId)?.workspaceId || conn.workspaceId
  if (!workspaceId || !workspaceSandboxes.isEnabled(workspaceId)) return true
  return workspaceSandboxes.resolved(workspaceId).controls.allWorkspaces
})

function workspaceOfGuest(guest: Electron.WebContents): string | undefined {
  for (const [paneId, wcId] of browserPanes) {
    if (wcId === guest.id) return getByPaneId(paneId)?.workspaceId
  }
  return undefined
}

function fenceBrowserGuest(guest: Electron.WebContents): void {
  const guard = (e: Electron.Event, url: string): void => {
    const workspaceId = workspaceOfGuest(guest)
    if (!workspaceId || browserFence.allowedNow(workspaceId, url)) return
    e.preventDefault()
    void browserFence.check(workspaceId, url).then((ok) => {
      if (ok && !guest.isDestroyed()) void guest.loadURL(url).catch(() => {})
    })
  }
  guest.on('will-navigate', guard)
  guest.on('will-redirect', guard)
}

const windows = new Map<string, BrowserWindow>()
const commandsByWindow = new Map<string, CommandDescriptor[]>()

const browserPanes = new Map<string, number>()

const consoleBuffers = new Map<number, ConsoleEntry[]>()
const errorBuffers = new Map<number, ConsoleEntry[]>()

const terminalState = new Map<string, TerminalStateSnapshot>()

let extensionHost: ExtensionHost | null = null

function refreshAgentPlugins(): void {
  try {
    setAgentPlugins(
      agentPluginContent(extensionHost?.agentPlugins() ?? [], (extId, problem) =>
        console.error(`[ext:${extId}] ${problem}`),
      ),
    )
  } catch (err) {
    console.error(`agent plugins: ${(err as Error).message}`)
  }
}
let viewHost: ViewHost | null = null
let mcpHost: McpHost | null = null
let mcpOAuth: McpOAuth | null = null
let broker: WindowBroker | null = null
const agentRunning = new AgentRunningPanes(() => broker?.persist())
const reachesPane: OriginReach = (senderWindowId, sourcePaneId, targetPaneId) =>
  broker?.reaches(senderWindowId, sourcePaneId, targetPaneId) ?? false
let settingsSync: SettingsSyncHandle | null = null

const EXTENSION_PARTITION_PREFIX = 'ostia-ext-'

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

function broadcast(channel: string, payload: unknown): void {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function extensionOfPartition(partition: string | undefined): string | null {
  if (!partition?.startsWith(EXTENSION_PARTITION_PREFIX)) return null
  return partition.slice(EXTENSION_PARTITION_PREFIX.length)
}

const instrumentedGuests = new WeakSet<Electron.WebContents>()
let clipboardEdits: ClipboardEdits | null = null
let guestChords: GuestChords | null = null

function instrumentBrowserGuest(gc: Electron.WebContents): void {
  const wcId = gc.id
  if (!instrumentedGuests.has(gc)) {
    instrumentedGuests.add(gc)
    gc.on('console-message', (_event, level, message) => {
      const entry: ConsoleEntry = {
        level: consoleLevelName(level),
        text: message,
        ts: Date.now(),
      }
      pushConsoleEntry(consoleBuffers, wcId, entry)
      if (entry.level === 'error' || message.startsWith(OSTIA_ERROR_PREFIX)) {
        pushConsoleEntry(errorBuffers, wcId, entry)
      }
    })
  }
  if (!gc.debugger.isAttached()) {
    try {
      gc.debugger.attach('1.3')
      gc.debugger
        .sendCommand('Page.enable')
        .then(() =>
          gc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: PAGE_ERROR_CATCHER_JS,
          }),
        )
        .catch(() => {})
    } catch {}
  }
  watchGuestNetwork(gc)
}

function hardenExtensionGuest(guest: Electron.WebContents): boolean {
  const host = extensionHost
  if (!host) return false
  const extId = host
    .panelExtensionIds()
    .find((id) => guest.session === session.fromPartition(`${EXTENSION_PARTITION_PREFIX}${id}`))
  if (!extId) return false
  guest.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  guest.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  const guard = (e: Electron.Event, url: string): void => {
    if (!host.isAllowedPanelUrl(extId, url)) e.preventDefault()
  }
  guest.on('will-navigate', guard)
  guest.on('will-redirect', guard)
  return true
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

let quitApproved = false
let quitAsking = false
let quitRequested = false

function requestQuit(): void {
  quitRequested = true
  app.quit()
}
const startedHidden = app.commandLine.hasSwitch('hidden')
let appTray: AppTray | null = null
let globalHotkey: GlobalHotkey | null = null
let managerService: ManagerService | null = null
let managerLimiter: ManagerLimiter | null = null
let portal: Portal | null = null

function wireWindow(win: BrowserWindow): void {
  win.once('ready-to-show', () => {
    if (startedHidden && appTray) appTray.hide(win)
    else win.show()
  })

  win.on('close', (event) => {
    if (quitApproved || broker?.isReturning(win)) return
    const action = closeAction({
      quitApproved,
      closeToTray: readCloseToTray(readSettingsFile()),
      startedHidden,
      managerLive: managerService?.live != null,
    })
    if (action === 'hide' && appTray && !broker?.isDetached(win)) {
      event.preventDefault()
      appTray.hide(win)
      return
    }
    event.preventDefault()
    if (broker?.isDetached(win)) broker.requestReturn(win, true)
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
    const extId = extensionOfPartition(params.partition)
    const allowed = extId
      ? (extensionHost?.isAllowedPanelUrl(extId, params.src) ?? false)
      : browserProfiles.acceptsAttach(params.partition, String(win.webContents.id))
    if (!allowed) {
      event.preventDefault()
      return
    }
    webPreferences.preload = undefined
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })
  win.webContents.on('did-attach-webview', (_e, guest) => {
    clipboardEdits?.guardGuest(guest)
    guestChords?.guardGuest(guest)
    if (hardenExtensionGuest(guest)) {
      attachContextMenu(guest, false)
      return
    }
    attachContextMenu(guest, true)
    const agent = browserUserAgent(guest.session.getUserAgent(), app.getName())
    guest.session.setUserAgent(agent)
    guest.setUserAgent(agent)
    instrumentBrowserGuest(guest)
    fenceBrowserGuest(guest)
    const wcId = guest.id
    guest.once('destroyed', () => {
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
    })
  })

  const wid = String(win.webContents.id)
  windows.set(wid, win)
  diagnostics?.watchWindow(win)
  win.on('closed', () => {
    windows.delete(wid)
    releaseWindowPtys(wid)
    fileWatches?.unwatchOwner(wid)
    commandsByWindow.delete(wid)
    for (const [paneId, wcId] of browserPanes) {
      if (getByPaneId(paneId)?.windowId === wid) {
        browserPanes.delete(paneId)
        consoleBuffers.delete(wcId)
        errorBuffers.delete(wcId)
        clearGuestBrowseState(wcId)
        clearGuestNetwork(wcId)
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

function createWindow(slot: string, bounds?: WindowBounds): BrowserWindow {
  const win = new BrowserWindow({
    ...(bounds ?? { width: 1280, height: 800 }),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1d2022',
    show: false,
    autoHideMenuBar: true,
    title: PRODUCT_DISPLAY_NAME,
    icon: appIcon,
    ...frameOptions(),
    webPreferences: baseWebPreferences(),
  })

  wireWindow(win)
  broker?.track(win, slot)

  if (devServerUrl) {
    win.loadURL(devServerUrl)
    if (slot === MAIN_SLOT) win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(app.getAppPath(), 'out/renderer/index.html'))
  }

  return win
}

function registerIpc(): void {
  ipcMain.handle('app:ping', () => 'pong' as const)
  ipcMain.handle('settings:path', () => join(app.getPath('userData'), 'settings.json'))
  ipcMain.handle('editor:open-external', (_e, req: ExternalEditorRequest) =>
    openInExternalEditor(req),
  )
  ipcMain.handle(
    'app:info',
    (): AppInfo => ({
      name: PRODUCT_DISPLAY_NAME,
      version: app.getVersion(),
      platform: process.platform,
      hostName: hostname(),
    }),
  )

  registerCloseGuard()
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('window:quit', () => requestQuit())
  ipcMain.handle('window:system-dark', () => nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('window:system-dark-changed', nativeTheme.shouldUseDarkColors)
      }
    }
  })
  ipcMain.on('window:beep', () => shell.beep())
  ipcMain.on('window:write-primary', (_e, text: unknown) => {
    if (acceptsPrimarySelection(process.platform, text)) clipboard.writeText(text, 'selection')
  })
  ipcMain.handle('window:set-zoom', (e, percent: unknown) => {
    const clamped = clampZoom(percent)
    e.sender.setZoomFactor(zoomFactor(clamped))
    return clamped
  })
  ipcMain.handle(
    'window:is-maximized',
    (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
  )

  ipcMain.on('lifecycle:event', (e, event: LifecycleEvent) => {
    const windowId = String(e.sender.id)
    const owner = 'paneId' in event ? getByPaneId(event.paneId)?.windowId : undefined
    if (owner && owner !== windowId && windows.has(owner)) return
    if (event.type === 'pane-created') {
      const identity = registerPane({
        windowId,
        workspaceId: event.workspaceId,
        paneId: event.paneId,
      })
      extensionHost?.emitEvent('pane.created', {
        paneId: identity.externalId,
        workspaceId: event.workspaceId,
      })
    } else if (event.type === 'pane-closed') {
      const identity = getByPaneId(event.paneId)
      if (identity) {
        dropIdentity(identity.externalId)
        approvals()?.forget(identity.externalId)
        questions()?.forget(identity.externalId)
        extensionHost?.emitEvent('pane.closed', {
          paneId: identity.externalId,
          workspaceId: event.workspaceId,
        })
      }
      extensionHost?.clearPaneChips(event.paneId)
      releaseMovingPane(event.paneId)
      if (managerService?.isManagerPane(event.paneId)) killPty(event.paneId, 'closed')
      if (ptys.has(event.paneId)) closedPanes.add(event.paneId)
      dropRestoredScrollback(event.paneId)
      hibernatedPanes.delete(event.paneId)
      browserProfiles.forget(event.paneId)
      removePane(event.paneId)
      terminalState.delete(event.paneId)
      processes?.paneClosed(event.paneId)
    } else if (event.type === 'workspace-added') {
      setWorkspaceWorkDir(event.workspaceId, event.workDir, windowId)
      scratchFolders.bind(event.workspaceId, event.workDir, windowId)
      extensionHost?.publishWorkspaceChips()
      extensionHost?.remoteFolders?.ownerChanged(event.workspaceId)
    } else if (event.type === 'workspace-closed') {
      removeWorkspace(event.workspaceId)
      processes?.workspaceClosed(event.workspaceId)
      extensionHost?.clearWorkspaceChips(event.workspaceId)
      extensionHost?.remoteFolders?.workspaceClosed(event.workspaceId)
      scratchFolders.remove(event.workspaceId)
      forgetWorkspaceRequests(event.workspaceId)
      forgetSandboxRuntime(event.workspaceId)
    } else if (event.type === 'workspace-activated') {
    } else if (event.type === 'workspace-state') {
      emitSessionState(event.workspaceId, event.state)
    }
  })

  ipcMain.on('commands:register', (e, descriptors: CommandDescriptor[]) => {
    commandsByWindow.set(String(e.sender.id), descriptors)
  })

  ipcMain.on('terminal:state', (_e, snapshot: TerminalStateSnapshot) => {
    const cur = terminalState.get(snapshot.paneId)
    if (!cur || snapshot.generation >= cur.generation) {
      const changed =
        !cur ||
        cur.cwd !== snapshot.cwd ||
        cur.running !== snapshot.running ||
        cur.blockCount !== snapshot.blockCount ||
        cur.lastExitCode !== snapshot.lastExitCode
      terminalState.set(snapshot.paneId, snapshot)
      if (changed) {
        const identity = getByPaneId(snapshot.paneId)
        if (identity) {
          emitTerminalExtensionEvents(identity.externalId, identity.workspaceId, cur, snapshot)
          emitPlatformEvent('pane.state', {
            paneId: identity.externalId,
            generation: snapshot.generation,
            cwd: snapshot.cwd,
            running: snapshot.running,
            blockCount: snapshot.blockCount,
            lastExitCode: snapshot.lastExitCode,
          })
        }
      }
    }
  })

  ipcMain.handle('browser:claim-profile', (e, paneId: unknown, profile: unknown) =>
    browserProfiles.claim(paneId, String(e.sender.id), profile),
  )
  ipcMain.on('browser:register', (e, paneId: string, webContentsId: number) => {
    const wid = String(e.sender.id)
    if (getByPaneId(paneId)?.windowId !== wid) return
    const gc = webContents.fromId(webContentsId)
    if (!gc || gc.getType() !== 'webview' || gc.hostWebContents?.id !== e.sender.id) return
    const expected = browserPartition(browserProfiles.profileOf(paneId), paneId)
    if (gc.session !== session.fromPartition(expected)) return
    browserPanes.set(paneId, webContentsId)
    instrumentBrowserGuest(gc)
  })
  ipcMain.on('browser:unregister', (e, paneId: string) => {
    const owner = getByPaneId(paneId)?.windowId
    if (owner && owner !== String(e.sender.id)) return
    cancelPick(paneId)
    const wcId = browserPanes.get(paneId)
    browserPanes.delete(paneId)
    if (wcId !== undefined) {
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
      clearGuestBrowseState(wcId)
      clearGuestNetwork(wcId)
    }
  })
}

function emitTerminalExtensionEvents(
  paneId: string,
  workspaceId: string,
  prev: TerminalStateSnapshot | undefined,
  next: TerminalStateSnapshot,
): void {
  const host = extensionHost
  if (!host) return
  if (next.cwd && prev?.cwd !== next.cwd) {
    host.emitEvent('cwd.changed', { paneId, workspaceId, cwd: next.cwd })
  }
  if (next.running && !prev?.running) {
    host.emitEvent('command.started', { paneId, workspaceId, cwd: next.cwd })
  } else if (!next.running && prev?.running) {
    host.emitEvent('command.finished', {
      paneId,
      workspaceId,
      cwd: next.cwd,
      exitCode: next.lastExitCode,
    })
  }
}

function registerExtensionIpc(host: ExtensionHost): void {
  ipcMain.handle('extensions:list', () => host.list())
  ipcMain.handle('extensions:set-enabled', (_e, extId: string, enabled: boolean) =>
    host.setEnabled(String(extId), enabled === true),
  )
  ipcMain.handle('extensions:approve', (_e, extId: string) => host.approve(String(extId)))
  ipcMain.handle('extensions:sidebar', () => host.sidebarItems())
  ipcMain.handle('extensions:chips', () => host.paneChips())
  ipcMain.handle('extensions:workspace-chips', (e) =>
    workspaceChipsForWindow(host.workspaceChips(), workspaceWindowId, String(e.sender.id)),
  )
  ipcMain.handle('extensions:set-setting', (_e, extId: unknown, key: unknown, value: unknown) =>
    host.setSetting(String(extId), String(key), value),
  )
  ipcMain.handle('extensions:set-secret', (_e, extId: unknown, key: unknown, value: unknown) =>
    host.setSecret(String(extId), String(key), value),
  )
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
    host.resolvePanel(String(extId), {
      workspaceId: String(context?.workspaceId ?? ''),
      locale: String(context?.locale ?? 'en'),
      ...(context?.path === undefined ? {} : { path: String(context.path) }),
    }),
  )
}

function remoteCwdOfPane(paneId: string): RemoteCwd | undefined {
  return normalizeRemoteCwd(terminalState.get(paneId)?.remote) ?? undefined
}

function publishRemoteFolders(folders: RemoteFolders): void {
  for (const [windowId, win] of windows) {
    if (win.isDestroyed()) continue
    win.webContents.send('remote-files:folders-changed', folders.forWindow(windowId))
  }
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
  ipcMain.handle('marketplace:remove', (_e, id: unknown) => marketplace.remove(id))
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
      servers: () => extensionHost?.languageServers() ?? [],
      extensions: () => extensionHost?.list() ?? [],
      listings: () => marketplace.languageListings(),
      dismissed: () => dismissed.list(),
      official: marketplaceId(normalizeMarketplaceUrl(OFFICIAL_MARKETPLACE) ?? ''),
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

function mergeWorkspace(sourceId: string, targetId: string): void {
  for (const identity of rehomeWorkspace(sourceId, targetId)) {
    extensionHost?.emitEvent('pane.created', {
      paneId: identity.externalId,
      workspaceId: targetId,
    })
  }
  for (const entry of ptys.values()) {
    if (entry.workspaceId === sourceId) entry.workspaceId = targetId
  }
  workspaceSandboxes.merge(sourceId, targetId)
  removeWorkspace(sourceId)
  forgetWorkspaceRequests(sourceId)
  mergedSandboxes.add(sourceId)
  releaseMergedSandbox(sourceId)
}

function registerPtyIpc(): void {
  registerWorkspaceMergeIpc({
    ownerWindow: windowForWorkspace,
    hasManager: workspaceHasManager,
    sandboxRefusal: (sourceId, targetId) => workspaceSandboxes.mergeRefusal(sourceId, targetId),
    merge: mergeWorkspace,
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
      extensionHost?.list().some((ext) => ext.id === 'system' && ext.enabled) ?? false,
    missing: (feature) => missingRequirements(feature),
    label: requirementLabel,
    invokeInstall: (args, caller) =>
      extensionHost
        ? extensionHost.invoke('system', 'install', args, caller)
        : Promise.resolve({ ok: false, error: 'extension-unavailable' }),
  })
  const attaching = new Map<string, Promise<PtyAttachResult>>()
  ipcMain.handle('pty:attach', async (e, paneId: string, opts: PtySpawnOptions) => {
    const previous = attaching.get(paneId)
    if (previous) await previous.catch(() => undefined)
    const pending = attachPty(e, paneId, opts)
    attaching.set(paneId, pending)
    try {
      return await pending
    } finally {
      if (attaching.get(paneId) === pending) attaching.delete(paneId)
    }
  })

  async function attachPty(
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    opts: PtySpawnOptions,
  ): Promise<PtyAttachResult> {
    const subId = String(e.sender.id)
    if (!panesOwnedBy([paneId], subId)) {
      return { created: false, buffer: '', cursor: 0, dropped: false }
    }
    const mkSub = () => ({
      id: subId,
      role: (opts.role ?? 'owner') as 'owner' | 'observer',
      send: (data: string) => {
        if (!e.sender.isDestroyed()) e.sender.send(`pty:data:${paneId}`, data)
      },
    })

    const existing = ptys.get(paneId)
    if (existing) {
      if (existing.killTimer) {
        clearTimeout(existing.killTimer)
        existing.killTimer = null
      }
      movingPanes.delete(paneId)
      recoveryHeld.delete(paneId)
      existing.subs.set(subId, e.sender)
      existing.session.addLiveSubscriber(mkSub())
      const { data, cursor, dropped } = existing.session.since(opts.sinceCursor ?? 0)
      return {
        created: false,
        buffer: data,
        cursor,
        dropped,
        shell: shellName(existing.shell) || undefined,
        sandboxed: existing.sandboxed,
        ...(existing.sandboxStamp ? { sandboxStamp: existing.sandboxStamp } : {}),
        cols: existing.pty.cols,
        rows: existing.pty.rows,
      }
    }
    if (opts.attachOnly) return { created: false, buffer: '', cursor: 0, dropped: false }

    const mod = loadPty()
    if (!mod) {
      return {
        created: false,
        buffer: '\r\n\x1b[38;2;239;89;111m node-pty unavailable — run: pnpm rebuild\x1b[0m\r\n',
        cursor: 0,
        dropped: false,
      }
    }
    const settings = readSettingsFile()
    const [shell, ...shellArgs] = shellArgv(
      settings.terminal?.shell,
      process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : 'bash'),
    )
    const resolved = attachWorkspace(getByPaneId(paneId)?.workspaceId, opts.workspaceId ?? '')
    if (!resolved.ok) {
      return {
        created: false,
        buffer: sandboxFailureBanner('the pane belongs to another workspace', []),
        cursor: 0,
        dropped: false,
      }
    }
    const identity = registerPane({ windowId: subId, workspaceId: resolved.workspaceId, paneId })
    const workspaceId = identity.workspaceId
    const integration = shellIntegrationSpawnOptions(
      shell,
      process.env,
      opts.ostiaPrompt ?? null,
      scratchFolders.historyFile(workspaceId),
    )
    const cols = opts.cols || 80
    const rows = opts.rows || 24
    const stateFile = join(privateTmpDir(`${PRODUCT_NAME}-shell-state`), randomUUID())
    let env = paneShellEnv({
      parent: process.env,
      integration: integration.env,
      pane: appEnv({
        PANE_ID: identity.externalId,
        TOKEN: identity.token,
        START_DIR: opts.cwd ?? '',
        SOCKET: controlSocketPath(),
        CLI: join(app.getAppPath(), 'out/cli/index.js'),
        NODE: process.execPath,
        SHELL_STATE: stateFile,
      }),
      agentHooks: settings.agents?.hooks,
    })
    let secretNotice = ''
    let sandboxStamp: string | null = null
    let resizePipe: string | null = null
    let portBridge: PortBridge | null = null
    let file = shell
    let args = [...integration.args, ...shellArgs]
    let cwd = resolveCwd(opts.cwd)
    const host = opts.hostToken ? hostPaneGrants.consume(opts.hostToken) : false
    const sandboxed = !host && workspaceId !== '' && workspaceSandboxes.isEnabled(workspaceId)
    if (sandboxed) {
      try {
        writeFileSync(stateFile, '', { mode: 0o600 })
        const secrets = await injectSecrets(workspaceId)
        secretNotice = secrets.notice
        resizePipe = needsPtyRelay(relayForced(app.isPackaged, process.env))
          ? join(workspaceSandboxes.tmpDir(workspaceId), `resize-${randomUUID()}`)
          : null
        portBridge = bridgesPorts(
          process.platform,
          workspaceSandboxes.resolved(workspaceId).switches.unixSockets,
        )
          ? await PortBridge.open(workspaceSandboxes.tmpDir(workspaceId))
          : null
        const wrapped = await workspaceSandboxes.wrap(
          workspaceId,
          sandboxedShellCommand(
            quoteArgv([shell, ...args]),
            env.SHELL,
            resizePipe,
            portBridge?.command ?? null,
          ),
          'bash',
          [stateFile],
        )
        sandboxStamp = workspaceSandboxes.wrapStamp(workspaceId)
        file = '/bin/sh'
        args = ['-c', wrapForTerminal(wrapped, resizePipe)]
        env = {
          ...sandboxSpawnEnv(env),
          ...packageCooldownEnv(
            workspaceSandboxes.packagePolicy(workspaceId).cooldownDays,
            Date.now(),
          ),
          ...secrets.env,
        }
        env.TMPDIR = workspaceSandboxes.tmpDir(workspaceId)
        cwd = sandboxCwd(cwd, workspaceSandboxes.workDir(workspaceId))
      } catch (err) {
        portBridge?.close()
        const missing = err instanceof SandboxUnavailableError ? err.missing : []
        onSandboxSpawnFailure?.(workspaceId, missing)
        return {
          created: false,
          buffer: sandboxFailureBanner(err instanceof Error ? err.message : String(err), missing),
          cursor: 0,
          dropped: false,
          sandboxed: true,
        }
      }
    }
    if (ptys.has(paneId)) {
      portBridge?.close()
      return attachPty(e, paneId, opts)
    }
    const pty = mod.spawn(file, args, {
      name: PTY_TERM_NAME,
      cols,
      rows,
      cwd,
      env,
    })
    const entry = trackPty(paneId, pty, {
      cols,
      rows,
      subs: new Map([[subId, e.sender]]),
      spawnPath: env.PATH ?? '',
      stateFile,
      keepAlive: false,
      workspaceId,
      sandboxed,
      shell,
      sandboxStamp,
      portBridge,
    })
    const { session } = entry
    if (sandboxed) {
      entry.exitListeners.add(() => {
        if (resizePipe) rmSync(resizePipe, { force: true })
        portBridge?.close()
        void workspaceSandboxes.cleanup(workspaceId)
        releaseMergedSandbox(workspaceId, entry)
      })
    }

    const history = takeRestoredScrollback(paneId)
    const seam = hibernatedPanes.delete(paneId) ? HIBERNATE_SEAM : RESTORE_SEAM
    if (history) feedPty(entry, `${history}${seam}`)
    if (secretNotice) feedPty(entry, secretNotice)
    if (sandboxed && workspaceSandboxes.claimHomeNotice(workspaceId)) {
      const notice = hiddenHomeNotice()
      if (notice) feedPty(entry, notice)
    }

    pty.onData((d) => feedPty(entry, d))
    pty.onExit(({ exitCode }) => session.exit(exitCode))
    const { data, cursor, dropped } = session.since(0)
    session.addLiveSubscriber(mkSub())
    return {
      created: true,
      buffer: data,
      cursor,
      dropped,
      shell: shellName(shell) || undefined,
      sandboxed,
      host,
      ...(sandboxStamp ? { sandboxStamp } : {}),
    }
  }

  ipcMain.on('pty:detach', (e, paneId: string) => {
    const entry = ptys.get(paneId)
    if (!entry) return
    const subId = String(e.sender.id)
    entry.subs.delete(subId)
    entry.session.removeSubscriber(subId)
  })

  ipcMain.handle('pty:hibernate', (_e, paneId: string): boolean => hibernatePty(String(paneId)))

  ipcMain.handle('pty:restart', (e, paneId: string): boolean => {
    const entry = ptys.get(String(paneId))
    if (!entry?.subs.has(String(e.sender.id))) return false
    killPty(String(paneId), 'restart')
    return true
  })

  ipcMain.on('pty:agent-running', (e, paneId: unknown, running: unknown) => {
    if (typeof paneId !== 'string' || typeof running !== 'boolean') return
    const attached = ptys.get(paneId)?.subs.has(String(e.sender.id)) === true
    agentRunning.report(paneId, running, attached)
  })

  ipcMain.on('pty:write', (e, paneId: string, data: string) => {
    const entry = ptys.get(paneId)
    if (entry?.session.canWrite(String(e.sender.id))) entry.pty.write(data)
  })
  ipcMain.handle('pty:foreground', (e, paneId: string): string | null => {
    const entry = ptys.get(paneId)
    if (!entry?.subs.has(String(e.sender.id))) return null
    try {
      const name = entry.pty.process
      return typeof name === 'string' && name ? (name.split('/').pop() ?? null) : null
    } catch {
      return null
    }
  })
  ipcMain.handle('pty:commands', async (e, paneId: string): Promise<string[]> => {
    const entry = ptys.get(paneId)
    if (!entry?.subs.has(String(e.sender.id))) return []
    if (!holdsLocalPrompt(entry)) return []
    const state = await readShellState(entry.stateFile)
    const path = state?.path ?? entry.spawnPath
    const rules = sandboxReadRules(entry)
    return commandNames(executables, rules ? sandboxPath(path, rules) : path, state?.names ?? [])
  })
  ipcMain.handle('pty:local-prompt', (e, paneId: string): boolean => {
    const entry = ptys.get(paneId)
    return entry?.subs.has(String(e.sender.id)) === true && holdsLocalPrompt(entry)
  })
  ipcMain.handle('pty:list-dir', (e, paneId: string, dir: string): FsEntry[] => {
    const entry = ptys.get(paneId)
    if (!entry?.subs.has(String(e.sender.id)) || !holdsLocalPrompt(entry)) return []
    const safe = resolveSafe(dir, fileRoots())
    if (safe === null) return []
    const rules = sandboxReadRules(entry)
    const entries = listDir(safe)
    return rules ? sandboxEntries(safe, entries, rules) : entries
  })
  ipcMain.handle(
    'pty:prompt-context',
    async (e, paneId: string, want: PromptContextRequest): Promise<PromptContext | null> => {
      const entry = ptys.get(paneId)
      if (!entry?.subs.has(String(e.sender.id))) return null
      const state = await readShellState(entry.stateFile)
      return promptContext(
        state,
        entry.spawnPath,
        terminalState.get(paneId)?.cwd,
        { node: want?.node === true, kube: want?.kube === true },
        promptSources,
      )
    },
  )
  ipcMain.on('pty:resize', (_e, paneId: string, cols: number, rows: number) => {
    const entry = ptys.get(paneId)
    if (!entry?.keepAlive) resizePty(entry, cols, rows)
  })
}

function trackPty(
  paneId: string,
  pty: IPty,
  opts: {
    cols: number
    rows: number
    subs: Map<string, Electron.WebContents>
    spawnPath: string
    stateFile: string
    keepAlive: boolean
    workspaceId?: string
    sandboxed?: boolean
    shell?: string
    sandboxStamp?: string | null
    portBridge?: PortBridge | null
  },
): PtyEntry {
  const spawnedAt = Date.now()
  const session = new PtySession({
    capBytes: PTY_BUFFER_CAP,
    onNoOwners: () => {
      if (
        ptys.get(paneId) !== entry ||
        entry.killTimer ||
        entry.keepAlive ||
        movingPanes.has(paneId)
      ) {
        return
      }
      scheduleReap(paneId, entry)
    },
    onExit: (code) => {
      appLog?.info('pty-exit', { pane: paneId, code })
      if (entry.killTimer) clearTimeout(entry.killTimer)
      entry.killTimer = null
      const closes = closesPaneOnExit({
        ownExit: ptys.get(paneId) === entry,
        code,
        livedMs: Date.now() - spawnedAt,
      })
      for (const wc of entry.subs.values()) {
        if (!wc.isDestroyed()) wc.send(`pty:exit:${paneId}`, code, closes)
      }
      for (const listener of entry.exitListeners) listener(code)
      processes?.shellEnded(paneId, (from) => session.since(from))
      entry.mirror.dispose()
      removeStateFile(entry)
      if (ptys.get(paneId) === entry) {
        ptys.delete(paneId)
        movingPanes.delete(paneId)
        agentRunning.shellEnded(paneId)
        recoveryHeld.delete(paneId)
        closedPanes.delete(paneId)
      }
    },
  })
  const entry: PtyEntry = {
    paneId,
    pty,
    session,
    mirror: new ScreenMirror(opts.cols, opts.rows),
    subs: opts.subs,
    killTimer: null,
    spawnPath: opts.spawnPath,
    stateFile: opts.stateFile,
    keepAlive: opts.keepAlive,
    exitListeners: new Set(),
    workspaceId: opts.workspaceId ?? '',
    sandboxed: opts.sandboxed ?? false,
    shell: opts.shell ?? '',
    sandboxStamp: opts.sandboxStamp ?? null,
    portBridge: opts.portBridge ?? null,
    confinedBy: opts.sandboxed ? (opts.workspaceId ?? '') : null,
  }
  ptys.set(paneId, entry)
  return entry
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
  const cwd = resolveCwd(req.cwd)
  const env = {
    ...process.env,
    ...(req.path === undefined ? {} : { PATH: req.path }),
    ...paneEnv(req.paneId, windowId, cwd),
    ...PTY_COLOR_ENV,
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

const MIRROR_SUBSCRIBER = 'portal-mirror'

function attachMirror(paneId: string, sink: MirrorSink): MirrorHandle | null {
  const entry = ptys.get(paneId)
  if (!entry) return null
  const onExit = (code: number): void => sink.exit(code)
  entry.exitListeners.add(onExit)
  entry.session.addSubscriber(
    { id: MIRROR_SUBSCRIBER, role: 'owner', send: (data) => sink.data(data) },
    0,
  )
  return {
    write: (data) => {
      if (ptys.get(paneId) === entry) entry.pty.write(data)
    },
    resize: (cols, rows) => {
      if (ptys.get(paneId) !== entry) return
      if (entry.pty.cols === cols && entry.pty.rows === rows) return
      resizePty(entry, cols, rows)
      for (const wc of entry.subs.values()) {
        if (!wc.isDestroyed()) wc.send(`pty:size:${paneId}`, cols, rows)
      }
    },
    detach: () => {
      entry.exitListeners.delete(onExit)
      entry.session.removeSubscriber(MIRROR_SUBSCRIBER)
    },
  }
}

const FILE_WATCH_DEBOUNCE_MS = 150
let fileWatches: FileWatches | null = null

function registerFsIpc(): void {
  const allowedRoots = fileRoots()
  const settingsFile = join(app.getPath('userData'), 'settings.json')
  registerOpenPathIpc(allowedRoots)
  registerProjectRootIpc(allowedRoots)

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

  ipcMain.handle('fs:read', (_e, path: string): string | null => {
    const safe = openFileGrants.confine(path)
    if (safe === null) return null
    try {
      return readFileSync(safe, 'utf8')
    } catch {
      return null
    }
  })

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

  fileWatches = new FileWatches({
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
    typeof path === 'string' ? (fileWatches?.watch(String(e.sender.id), path) ?? false) : false,
  )
  ipcMain.on('fs:unwatch', (e, path: unknown) => {
    if (typeof path === 'string') fileWatches?.unwatch(String(e.sender.id), path)
  })

  ipcMain.handle('fs:write', (_e, path: string, content: string): boolean => {
    const safe = openFileGrants.confine(path)
    if (safe === null) return false
    try {
      writeFileSync(safe, content, 'utf8')
      if (safe === settingsFile) {
        for (const win of windows.values()) {
          if (!win.isDestroyed()) win.webContents.send('settings:changed')
        }
        extensionHost?.refreshLocale()
        extensionHost?.reloadAssistSettings()
        applyGlobalHotkey()
      }
      return true
    } catch {
      return false
    }
  })
}

export function listCommandsFor(windowId: string): CommandDescriptor[] {
  return commandsByWindow.get(windowId) ?? []
}

export function getTerminalState(paneId: string): TerminalStateSnapshot | undefined {
  return terminalState.get(paneId)
}

function primaryWindowId(): string | undefined {
  return broker?.windowIds()[0] ?? [...windows.keys()][0]
}

function windowIds(): string[] {
  return broker?.windowIds() ?? [...windows.keys()]
}

const workspaceWindowId = firstKnownOwner(
  (workspaceId) => broker?.windowOfWorkspace(workspaceId),
  windowOfWorkspace,
  windowForWorkspace,
)

function openSettingsInFocusedWindow(): void {
  const focused = BrowserWindow.getFocusedWindow()
  const entry = [...windows].find(([, win]) => win === focused)
  void execCommand({ windowId: entry?.[0], workspaceId: '', paneId: null }, 'app.openSettings')
}

function mainWindow(): BrowserWindow | undefined {
  return broker?.mainWindow() ?? [...windows.values()][0]
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

export function ptyResize(rendererPaneId: string, cols: number, rows: number): void {
  resizePty(ptys.get(rendererPaneId), cols, rows)
}

export function ptyWrite(rendererPaneId: string, data: string): void {
  ptys.get(rendererPaneId)?.pty.write(data)
}

let reqSeq = 0

export function execCommand(
  target: CommandTarget,
  id: string,
  args?: unknown,
): Promise<CommandResult> {
  const win = target.windowId ? windows.get(target.windowId) : mainWindow()
  if (!win || win.isDestroyed()) {
    return Promise.resolve({
      ok: false,
      error: { code: 'command-failed', message: 'target window not available' },
    })
  }
  const reqId = `cmd-${++reqSeq}`
  return new Promise((resolve) => {
    const onResult = (_e: Electron.IpcMainEvent, rid: string, result: CommandResult): void => {
      if (rid !== reqId) return
      clearTimeout(timer)
      ipcMain.removeListener('command:result', onResult)
      resolve(result)
    }
    ipcMain.on('command:result', onResult)
    win.webContents.send('command:invoke', reqId, { id, args, target })
    const timer = setTimeout(() => {
      ipcMain.removeListener('command:result', onResult)
      resolve({ ok: false, error: { code: 'command-failed', message: 'command timed out' } })
    }, 5000)
  })
}

function publishWorkspaceChips(chips: WorkspaceChip[]): void {
  for (const [windowId, win] of windows) {
    if (win.isDestroyed()) continue
    win.webContents.send(
      'extensions:workspace-chips',
      workspaceChipsForWindow(chips, workspaceWindowId, windowId),
    )
  }
}

function sendToWorkspaceWindow(
  workspaceId: string | undefined,
  channel: string,
  payload: unknown,
): void {
  const windowId = workspaceId ? workspaceWindowId(workspaceId) : undefined
  const win = (windowId ? windows.get(windowId) : undefined) ?? mainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function extensionSecretStore() {
  return encryptedStore(storePath('extension-secrets', 'global'))
}

function assistKeyStore() {
  return encryptedStore(storePath('assist-keys', 'global'))
}

function encryptedFile(path: string): SecretStoreDeps {
  return {
    load: () => loadJson<unknown>(path, {}),
    save: (data) => saveJson(path, data, { secure: true }),
    canEncrypt: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret, 'base64')),
  }
}

function encryptedStore(path: string) {
  return createSecretStore(encryptedFile(path))
}

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
  workspaces?: { globalHotkey?: unknown }
  manager?: unknown
  assistant?: unknown
  terminal?: { shell?: unknown }
  agents?: { hooks?: unknown }
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

function focusPaneInWindow(pane: PaneIdentity): boolean {
  const win = windows.get(pane.windowId)
  if (!win || win.isDestroyed()) return false
  showWindow(win)
  win.webContents.send('extensions:focus-pane', pane.paneId)
  return true
}

const OPEN_TERMINAL_TIMEOUT_MS = 5000
let openTerminalSeq = 0

function openTerminalInWindow(req: TerminalOpenRequest): Promise<string | null> {
  const { windowId: requestedWindow, ...payload } = req
  const windowId =
    requestedWindow ?? (req.workspaceId ? workspaceWindowId(req.workspaceId) : undefined)
  const win = (windowId ? windows.get(windowId) : undefined) ?? mainWindow()
  if (!win || win.isDestroyed()) return Promise.resolve(null)
  const wid = String(win.webContents.id)
  const requestId = `term-${++openTerminalSeq}`
  return new Promise((resolve) => {
    const finish = (paneId: string | null): void => {
      clearTimeout(timer)
      ipcMain.removeListener('extensions:open-terminal-result', onResult)
      resolve(paneId)
    }
    const onResult = (e: Electron.IpcMainEvent, rid: unknown, paneId: unknown): void => {
      if (rid !== requestId || String(e.sender.id) !== wid) return
      finish(
        typeof paneId === 'string' && paneId
          ? registerPane({ windowId: wid, workspaceId: '', paneId }).externalId
          : null,
      )
    }
    const timer = setTimeout(() => finish(null), OPEN_TERMINAL_TIMEOUT_MS)
    ipcMain.on('extensions:open-terminal-result', onResult)
    win.webContents.send('extensions:open-terminal', { ...payload, requestId })
  })
}

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
  if (win && !win.isDestroyed() && !win.isVisible()) appTray?.showWindows()
}

async function openWorker(req: {
  argv: string[]
  cwd?: string
  workspaceId?: string
  name?: string
}): Promise<string | null> {
  let workspaceId = req.workspaceId
  if (!workspaceId) {
    const created = await execCommand({ workspaceId: '', paneId: null }, 'workspace.new', {
      ...(req.cwd ? { dir: req.cwd } : {}),
      ...(req.name ? { name: req.name } : {}),
    })
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
  if (!managerService || !portalSupported(process.platform)) return
  const service = managerService
  portal = new Portal(portalSocketPath(app.isPackaged), {
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
  portal
    .start()
    .then((started) => {
      if (!started) console.warn(`[portal] another ${PRODUCT_DISPLAY_NAME} owns the portal socket`)
    })
    .catch((err) => console.error('[portal] failed to start', err))
}

function emitFocusChanged(): void {
  extensionHost?.emitEvent('focus.changed', { focused: BrowserWindow.getFocusedWindow() !== null })
}

function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleAllWindows(): void {
  toggleWindows(BrowserWindow.getAllWindows(), appTray, revealApp)
}

function applyGlobalHotkey(): void {
  const status = globalHotkey?.apply(readSettingsFile().workspaces?.globalHotkey)
  if (status === 'taken') console.warn('[global hotkey] the chosen shortcut is in use elsewhere')
}

function revealApp(): void {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(MAIN_SLOT)
  else appTray?.showWindows()
}

app.on('second-instance', (_event, argv) => {
  if (!app.isReady() || isHiddenLaunch(argv)) return
  revealApp()
})

app.whenReady().then(() => {
  installAppMenu(process.platform, {
    productName: PRODUCT_DISPLAY_NAME,
    openSettings: openSettingsInFocusedWindow,
  })
  const logDir = join(app.getPath('userData'), 'logs')
  appLog = createAppLog(join(logDir, LOG_FILE_NAME))
  diagnostics = registerDiagnostics({
    log: appLog,
    logDir,
    testHooks: process.env.NODE_ENV === 'test',
    startRecovery,
    finishRecovery,
    openPath: (path) => shell.openPath(path),
  })
  loadRestoredScrollback()
  scratchFolders.sweep()
  workspaceSandboxes.sweepTmp()
  registerScratchIpc(scratchFolders)
  clipboardEdits = registerClipboardEdits({
    ipc: ipcMain,
    isAppWindow: (sender) => windows.get(String(sender.id))?.webContents === sender,
    availableFormats: () => clipboard.availableFormats(),
    mac: process.platform === 'darwin',
  })
  guestChords = registerGuestChords({
    ipc: ipcMain,
    isAppWindow: (sender) => windows.get(String(sender.id))?.webContents === sender,
    mac: process.platform === 'darwin',
  })
  registerIpc()
  registerPtyIpc()
  registerFsIpc()
  registerSelectionIpc(reachesPane, redactor.text)
  registerPrivacyIpc(redactor)
  registerApprovals(revealWindow)
  registerQuestions()
  registerCredentials()
  registerAppUpdate(requestQuit)
  registerReleaseCheck({
    openExternal: openExternalSafe,
    readSettings: readSettingsFile,
    log: appLog,
  })
  registerAgentTranscriptIpc()
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
  onSandboxSpawnFailure = (workspaceId, errors) =>
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
            canInstall: extensionHost?.list().some((x) => x.id === 'system' && x.enabled) ?? false,
          }
        },
      },
      workspaceId,
      errors,
    )
  registerNotifyIpc(notifyDeps)
  registerAttentionMethods({ execCommand })
  registerPaneResumeMethods({
    execCommand,
    onResume: (identity, resume) => {
      if (identity.manager) managerService?.rememberResume(resume)
    },
  })
  const registry = registerProcessMethods({
    openTab: openTerminalInWindow,
    ring: (paneId) => {
      const session = ptys.get(paneId)?.session
      return session ? (from) => session.since(from) : undefined
    },
    writePane: paneIo.write,
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
    interruptGraceMs: INTERRUPT_GRACE_MS,
  })
  processes = registry
  registerPaneIoMethods({
    io: paneIo,
    state: getTerminalState,
    processPane: (ref, ctx) => {
      const entry = registry.resolve(
        ref,
        ctx.identity.workspaceId,
        connHasCap(ctx.authed, 'all-workspaces'),
      )
      return entry && entry.status !== 'closed' ? entry.paneId : undefined
    },
    isChild: (ownerPaneId, paneId) => registry.isChild(ownerPaneId, paneId),
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isConfined: (paneId) => ptys.get(paneId)?.sandboxed === true,
    managerAllowsInput: () => managerSettings().allowInput,
  })
  registerDocsMethods({ extensions: () => extensionHost?.listForAgents() ?? [] })
  registerVaultMethods({ isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId) })
  registerOpenFileMethods({
    grants: openFileGrants,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    execCommand,
  })
  registerBusMethods({
    managerSendAllowed: () => managerLimiter?.busAllowed() ?? true,
    announce: (from, to, text) => {
      void announceBusMessage(
        {
          execCommand,
          listPanes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds }),
          listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
        },
        from,
        to,
        text,
      ).catch(() => {})
    },
  })
  const extensionStore = new ExtensionStore(join(app.getPath('userData'), 'extensions.json'))
  settingsSync = startSettingsSync({
    userData: app.getPath('userData'),
    broadcast: (channel, payload) => broadcast(channel, payload),
    onExtensionsPulled: () => {
      extensionStore.reload()
      extensionHost?.reloadRecords()
    },
    onSettingsPulled: () => {
      extensionHost?.reloadSettings()
      extensionHost?.refreshLocale()
    },
  })
  settingsSync.run()
  extensionHost = new ExtensionHost({
    onChanged: () => {
      languageServers?.refresh()
      refreshAgentPlugins()
    },
    hostGrants: hostPaneGrants,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    roots: extensionRoots(),
    store: extensionStore,
    socketPath: controlSocketPath,
    nodePath: process.execPath,
    dataDir: join(app.getPath('userData'), 'extension-data'),
    workDirForWorkspace,
    cwdForPane: (paneId) => terminalState.get(paneId)?.cwd,
    remoteCwdForPane: remoteCwdOfPane,
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
    openAssistUiIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'assist:open-ui', req),
    broadcast,
    publishWorkspaceChips,
    openPanelIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-panel', req),
    openDiffIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-diff', req),
    openTerminalIn: openTerminalInWindow,
    notify: (n) => postNotification(notifyDeps, n),
    confirm: (req) => confirmForExtension(req, windows.values()),
    notifyPanel: (n, open) => postPanelNotification(notifyDeps, n, open),
    agentArgv: (name) => managerAgents(managerSettings())[name] ?? null,
    agentNames: () => Object.keys(managerAgents(managerSettings())),
    offerToAgentIn: (offer) => agentOffers.offer(offer),
    focusPaneIn: focusPaneInWindow,
  })
  refreshAgentPlugins()
  registerExtensionMethods(() => extensionHost)
  registerExtensionIpc(extensionHost)
  registerRemoteFilesIpc(extensionHost)
  ipcMain.on(AGENT_OFFER_RESULT_CHANNEL, (e, requestId: unknown, paneId: unknown) =>
    agentOffers.answer(String(e.sender.id), requestId, paneId),
  )
  languageServers = createLanguageServers()
  languageServers.refresh()
  registerLanguageServersIpc({
    servers: languageServers,
    setEnabled: (extId, serverId, enabled) =>
      extensionHost?.setLanguageServerEnabled(extId, serverId, enabled),
    setOverride: (key, override) => serverOverrides.choose(key, override),
  })
  registerMarketplaceIpc(
    new Marketplace({
      recordsPath: join(app.getPath('userData'), 'marketplaces.json'),
      clonesDir: join(app.getPath('userData'), 'marketplaces'),
      extensionsDir: join(configDir(), 'extensions'),
      builtinIds: () =>
        extensionHost
          ?.list()
          .filter((ext) => ext.builtin)
          .map((ext) => ext.id) ?? [],
      forget: (extId) => {
        managedServers.forgetExtension(extId)
        serverOverrides.forgetExtension(extId)
        extensionStore.delete(extId)
        for (const secrets of [extensionSecretStore(), assistKeyStore()]) {
          for (const key of secrets.keys(extId)) secrets.set(extId, key, null)
        }
      },
      rescan: () => extensionHost?.rescan(),
      locale: readLocale,
    }),
  )
  registerAssistIpc(() => extensionHost)
  registerChatSessionIpc(
    createChatSessionStore({ dir: join(dirname(storePath('chat', 'global')), 'chat-sessions') }),
    redactor.text,
  )
  const mcpSecretsPath = storePath('mcp-secrets', 'global')
  const mcpSecrets = encryptedStore(mcpSecretsPath)
  const chatToolSettings = () => parseChatToolSettings(readSettingsFile().assistant)
  mcpOAuth = new McpOAuth({
    store: createMcpOAuthStore(encryptedFile(mcpSecretsPath)),
    openExternal: openExternalSafe,
    browser: mcpOAuthBrowser(app.isPackaged, process.env),
    locale: readLocale,
    onChange: () => mcpHost?.notify(),
  })
  mcpHost = new McpHost({
    servers: () => chatToolSettings().mcpServers,
    secret: (server, key) => mcpSecrets.get(server, key),
    onStatus: (status) => broadcast('chatTools:mcp-status', status),
    auth: mcpOAuth,
  })
  registerChatToolsIpc({
    roots: fileRoots,
    settings: chatToolSettings,
    mcp: mcpHost,
    secrets: mcpSecrets,
    oauth: mcpOAuth,
  })
  const workflowDeps: WorkflowDeps = {
    userDir: join(configDir(), 'workflows'),
    roots: () => [homedir(), app.getPath('userData')],
    workDirForWorkspace,
    extensionWorkflows: () => extensionHost?.workflows() ?? [],
  }
  registerWorkflowIpc(workflowDeps)
  registerWorkflowMethods(workflowDeps)
  registerCompletionIpc({
    userDir: join(configDir(), 'completions'),
    extensionDirs: () => extensionHost?.completionDirs() ?? [],
  })
  viewHost = new ViewHost({
    dir: join(configDir(), 'views'),
    store: new ViewStore(join(app.getPath('userData'), 'views.json')),
    onChange: (listing) => broadcast('views:changed', listing),
    log: (line) => console.warn(`[views] ${line}`),
  })
  registerViewsIpc(viewHost)
  registerViewMethods({ host: viewHost, execCommand })
  registerIconThemeIpc({
    themes: () => extensionHost?.iconThemes() ?? [],
    onError: (id, error) => console.warn(`[icon theme ${id}] ${error}`),
  })
  registerKeymapIpc({
    keymaps: () => extensionHost?.keymaps() ?? [],
    platform: process.platform,
    onError: (ref, error) => console.warn(`[keymap ${ref}] ${error}`),
    onSkipped: (ref, skipped) =>
      console.warn(`[keymap ${ref}] skipped entries: ${describeSkipped(skipped)}`),
  })
  registerLanguagePackIpc({
    languages: () => extensionHost?.languages() ?? [],
    onError: (extId, error) => console.warn(`[language pack ${extId}] ${error}`),
  })
  registerEditorLanguageIpc({
    languages: () => extensionHost?.editorLanguages() ?? [],
    onError: (extId, error) => console.warn(`[editor language ${extId}] ${error}`),
  })
  platformEvents.on('notify', (n: { title: string; body?: string; from: string }) =>
    extensionHost?.emitEvent('notification', n),
  )
  registerPaneListMethods({ execCommand, getTerminalState, ptyPid, windowIds })
  registerGatewayMethods()
  registerGatewayIpc()
  configureGatewayControl({
    execCommand,
    listCommandsFor,
    getTerminalState,
    listPanes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds }),
    listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
    primaryWindowId,
    attachPhoneObserver,
    ptyResize,
    ptyWrite,
  })
  const sharedBrowser = session.fromPartition(SHARED_BROWSER_PARTITION)
  sharedBrowser.setUserAgent(browserUserAgent(sharedBrowser.getUserAgent(), app.getName()))
  const isSharedPane = (paneId: string): boolean => browserProfiles.isShared(paneId)
  registerBrowseMethods({
    allowNavigation: (workspaceId, url) => browserFence.check(workspaceId, url),
    browserPanes,
    isSharedPane,
    execCommand,
    screenshotRoots: [homedir(), app.getPath('userData')],
    consoleBuffers,
    errorBuffers,
  })
  registerPickMethods({ browserPanes, isSharedPane, errorBuffers, broadcast })
  registerPickIpc(
    { browserPanes, isSharedPane, errorBuffers, broadcast },
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
  })
  registerControlServer({ execCommand, listCommandsFor, getTerminalState })
  registerManagerIpc()
  managerLimiter = registerManagerMethods({
    settings: managerSettings,
    agents: () => managerAgents(managerSettings()),
    io: paneIo,
    openWorker,
    paneAlive: (paneId) => getByPaneId(paneId) !== undefined,
    now: Date.now,
  })
  managerService = new ManagerService({
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
  appTray = new AppTray({
    iconPath: appIcon,
    tooltip: PRODUCT_DISPLAY_NAME,
    locale: readLocale,
    windows: () => BrowserWindow.getAllWindows(),
    quit: requestQuit,
    setBadgeCount: (count) => app.setBadgeCount(count),
  })
  globalHotkey = new GlobalHotkey(globalShortcut, toggleAllWindows)
  applyGlobalHotkey()
  broker = new WindowBroker({
    createWindow,
    holdPtys,
    execCommand,
    agents: agentRunning,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    reveal: showWindow,
    onList: (list) => appTray?.setUnread(unreadWorkspaces(list)),
  })
  broker.register()
  broker.openAll()
  extensionHost.startEager()
  extensionHost.watchUserExtensions()
  viewHost.watch()
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
  if (broker && !broker.persisting) return scrollbackSaves
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
    .then(async () => saveScrollback(await redactScrollback(toSave)))
    .catch((err: unknown) => console.error('[workspace] scrollback save failed', err))
  return scrollbackSaves
}

let scrollbackSavedForQuit = false
let savingScrollbackForQuit = false

const SCROLLBACK_AUTOSAVE_MS = 5000
let lastScrollbackSignature = ''

function autosaveScrollback(): void {
  let signature = ''
  for (const [paneId, entry] of ptys) signature += `${paneId}:${entry.session.since(0).cursor};`
  signature += `pending:${Object.keys(pendingRestoredScrollback()).length}`
  if (signature === lastScrollbackSignature) return
  lastScrollbackSignature = signature
  void persistScrollback()
}

app.on('before-quit', (event) => {
  const plan = planQuit({
    approved: quitApproved,
    requestedByOstia: quitRequested,
    platform: process.platform,
  })
  quitRequested = false
  if (plan === 'unattended') {
    quitApproved = true
    freezeAll(BrowserWindow.getAllWindows())
    exitAfterDeadline(() => app.exit(0))
  }
  if (plan === 'ask') {
    event.preventDefault()
    if (quitAsking) return
    quitAsking = true
    const all = BrowserWindow.getAllWindows()
    void confirmQuit(all, BrowserWindow.getFocusedWindow() ?? mainWindow(), (workspaceId) =>
      scratchFolders.countFiles(workspaceId),
    ).then((approved) => {
      quitAsking = false
      if (!approved) return
      quitApproved = true
      freezeAll(all)
      app.quit()
    })
    return
  }
  if (!scrollbackSavedForQuit) {
    event.preventDefault()
    if (savingScrollbackForQuit) return
    savingScrollbackForQuit = true
    void persistScrollback().finally(() => {
      scrollbackSavedForQuit = true
      app.quit()
    })
    return
  }
  broker?.persist()
  managerService?.shutdown()
  appLog?.info('app-quit', { ptys: ptys.size })
  for (const entry of ptys.values()) {
    try {
      entry.pty.kill()
    } catch {}
    entry.mirror.dispose()
    removeStateFile(entry)
  }
  ptys.clear()
  languageServers?.stopAll()
  languageServerWatches.closeAll()
  workspaceSandboxes.stopAll()
  workspaceAgents.stopAll()
  for (const workspaceId of scratchFolders.workspaceIds()) workspaceSandboxes.forget(workspaceId)
  workspaceSandboxes.clearTmp()
  scratchFolders.removeAll()
  portForwarder.stopAll()
  extensionHost?.stopAll()
  mcpOAuth?.closeAll()
  mcpHost?.closeAll()
  viewHost?.stop()
  settingsSync?.stop()
  stopControlServer()
  portal?.stop()
  void stopGateway()
  appTray?.remove()
  globalHotkey?.clear()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') requestQuit()
})
