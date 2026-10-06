import type { AgentResume, ResumableAgent } from './agentResume'
import type { AgentSessionInfo } from './agentSessionInfo'
import type { AppMenuSpec } from './appMenu'
import type { ApprovalAnswer, ApprovalState } from './approvals'
import type { AssistApi } from './assist'
import type { BrowserProfile } from './browserProfile'
import type {
  BrowserStorageRead,
  StorageEdit,
  StorageKind,
  StorageRemoval,
  StorageWriteResult,
} from './browserStorage'
import type { BuildInfo } from './buildInfo'
import type { Capability, PhoneGrantableCap } from './capabilities'
import type { ChatSessionsApi } from './chatSessions'
import type { ChatToolsApi } from './chatTools'
import type { ClipboardChords, ClipboardEdit } from './clipboardChords'
import type { CmuxSessionRead } from './cmuxSession'
import type { SpecCommand } from './completionSpec'
import type {
  CredentialImportResult,
  CredentialInput,
  CredentialSaveResult,
  CredentialSummary,
} from './credentials'
import type { EditorLanguagesApi } from './editorLanguages'
import type { SuggestionsApi } from './extensionSuggestions'
import type { ExtensionResult, ExtensionsApi } from './extensions'
import type { FileOpsApi } from './fileOps'
import type { GuestChordFire } from './guestChords'
import type { IconThemesApi } from './iconTheme'
import type { KeymapsApi } from './keymapFile'
import type { LanguagePacksApi } from './languagePack'
import type { LspApi } from './languageServers'
import type { MarketplaceApi } from './marketplace'
import type { OpenFileVerdict } from './openFiles'
import type { PickOutcome, PickSendRequest, PickSendResult, PickState, PickTheme } from './pick'
import type { PromptSeparator } from './promptSettings'
import type { QuestionReply, QuestionState } from './questions'
import type { PrivacyApi } from './redaction'
import type {
  RegionCaptureOutcome,
  RegionCaptureRequest,
  RegionCopyResult,
  RegionSendRequest,
} from './regionCapture'
import type { ReleaseCheckResult, ReleaseInfo } from './releases'
import type {
  RemoteCwd,
  RemoteFolder,
  RemoteFolderAsk,
  RemoteListResult,
  RemoteReadResult,
  RemoteStatResult,
  RemoteWriteResult,
} from './remoteFolders'
import type {
  PortsPolicy,
  SandboxControls,
  SandboxEditError,
  SandboxEditResult,
  SandboxEnableResult,
  SandboxExposeResult,
  SandboxFixedPolicy,
  SandboxMergeRefusal,
  SandboxPathKind,
  SandboxPortRow,
  SandboxSwitches,
  SandboxViolation,
  WorkspacePackages,
  WorkspaceSandbox,
} from './sandbox'
import type { SandboxReadPreset } from './sandboxPresets'
import type { SearchApi } from './search'
import type { SecretEntry, SecretGrant } from './secrets'
import type { SelectionSendRequest, SelectionSendResult } from './selection'
import type { RequirementsReport } from './systemRequirements'
import type { ViewsApi } from './views'
import type { WorkflowDocument, WorkflowListing, WorkflowSaveResult } from './workflows'
import type { WorkspaceGroupColor } from './workspaceGroups'

export type Platform = 'darwin' | 'linux' | 'win32' | (string & {})

export interface AppInfo {
  name: string
  version: string
  platform: Platform
  hostName: string
  home: string
}

export const RENDERER_ERROR_KINDS = ['error', 'rejection', 'render', 'surface'] as const
export type RendererErrorKind = (typeof RENDERER_ERROR_KINDS)[number]

export interface RendererErrorReport {
  kind: RendererErrorKind
  message: string
  stack?: string
  source?: string
}

export interface DiagnosticsApi {
  report: (report: RendererErrorReport) => void
  ready: (paneIds: string[]) => void
  reloadWindow: () => void
  toggleDevTools: () => void
  openLogFolder: () => Promise<boolean>
  testHooks: () => Promise<boolean>
  onTestCrash: (handler: () => void) => () => void
}

export interface WindowControls {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  quit: () => void
  isMaximized: () => Promise<boolean>
  setZoom: (percent: number) => Promise<number>
  beep: () => void
  writePrimarySelection: (text: string) => void
  isSystemDark: () => Promise<boolean>
  onSystemDarkChange: (cb: (dark: boolean) => void) => () => void
  onMaximizeChange: (cb: (maximized: boolean) => void) => () => void
  onRunningQuery: (cb: (kept: string[]) => RunningGroup[] | Promise<RunningGroup[]>) => () => void
  onConfirmClose: (cb: (groups: RunningGroup[]) => Promise<boolean>) => () => void
  onFreeze: (cb: () => void) => () => void
}

export interface RunningGroup {
  workspaceId: string
  workspace: string
  commands: string[]
  agents?: string[]
  files: string[]
  scratchFiles?: number
}

export interface PtySpawnOptions {
  cwd?: string
  cols: number
  rows: number
  role?: 'owner' | 'observer'
  sinceCursor?: number
  ostiaPrompt?: OstiaPromptSpawn
  workspaceId?: string
  hostToken?: string
  attachOnly?: boolean
}

export interface OstiaPromptSpawn {
  separator: PromptSeparator
  sameLine: boolean
}

export interface PromptContextRequest {
  node: boolean
  kube: boolean
}

export interface PromptContext {
  user: string
  host: string
  home: string
  virtualEnv: string | null
  condaEnv: string | null
  nodeVersion: string | null
  kubeContext: string | null
}

export interface PtyAttachResult {
  created: boolean
  buffer: string
  cursor: number
  dropped: boolean
  shell?: string
  sandboxed?: boolean
  sandboxStamp?: string
  host?: boolean
  cols?: number
  rows?: number
  kept?: boolean
  reattached?: boolean
}

export interface SystemApi {
  requirements: (feature: string) => Promise<RequirementsReport | null>
  installRequirements: (feature: string, workspaceId: string) => Promise<ExtensionResult>
}

export interface SecretsApi {
  view: (workspaceId: string) => Promise<{ secrets: SecretEntry[]; grants: SecretGrant[] } | null>
  setGrants: (workspaceId: string, grants: SecretGrant[]) => Promise<SandboxEditResult>
  vaultSet: (workspaceId: string, key: string, value: string) => Promise<boolean>
  vaultDelete: (workspaceId: string, key: string) => Promise<boolean>
}

export interface SandboxApi {
  get: (workspaceId: string) => Promise<WorkspaceSandbox | null>
  setEnabled: (workspaceId: string, enabled: boolean) => Promise<SandboxEnableResult>
  setPaths: (
    workspaceId: string,
    kind: SandboxPathKind,
    paths: string[],
  ) => Promise<SandboxEditResult>
  checkPaths: (kind: SandboxPathKind, paths: string[]) => Promise<SandboxEditError[]>
  presets: () => Promise<SandboxReadPreset[]>
  setDomains: (workspaceId: string, domains: string[]) => Promise<SandboxEditResult>
  setDeniedDomains: (workspaceId: string, domains: string[]) => Promise<SandboxEditResult>
  setSwitches: (
    workspaceId: string,
    switches: Partial<SandboxSwitches>,
  ) => Promise<WorkspaceSandbox | null>
  fixedPolicy: (workspaceId?: string) => Promise<SandboxFixedPolicy | null>
  stamp: (workspaceId: string) => Promise<string | null>
  violations: (workspaceId: string) => Promise<SandboxViolation[]>
  clearViolations: (workspaceId: string) => Promise<boolean>
  setControls: (
    workspaceId: string,
    controls: Partial<SandboxControls>,
  ) => Promise<WorkspaceSandbox | null>
  allowRefused: (workspaceId: string, host: string) => Promise<boolean>
  globalsChanged: () => Promise<boolean>
  setPackages: (
    workspaceId: string,
    packages: WorkspacePackages,
  ) => Promise<WorkspaceSandbox | null>
  ports: (workspaceId: string) => Promise<SandboxPortRow[]>
  expose: (workspaceId: string, port: number) => Promise<SandboxExposeResult>
  unexpose: (workspaceId: string, port: number) => Promise<boolean>
  setPortsPolicy: (
    workspaceId: string,
    policy: PortsPolicy | undefined,
  ) => Promise<WorkspaceSandbox | null>
  onBlocked: (
    cb: (blocked: { workspaceId: string; report: RequirementsReport }) => void,
  ) => () => void
}

export interface PtyApi {
  attach: (paneId: string, opts: PtySpawnOptions) => Promise<PtyAttachResult>
  detach: (paneId: string) => void
  hibernate: (paneId: string) => Promise<boolean>
  restart: (paneId: string) => Promise<boolean>
  reportAgentRunning: (paneId: string, running: boolean) => void
  write: (paneId: string, data: string) => void
  resize: (paneId: string, cols: number, rows: number) => void
  commands: (paneId: string) => Promise<string[]>
  foreground: (paneId: string) => Promise<string | null>
  busy: (paneId: string) => Promise<string | null>
  promptContext: (paneId: string, want: PromptContextRequest) => Promise<PromptContext | null>
  onData: (paneId: string, cb: (data: string) => void) => () => void
  onExit: (paneId: string, cb: (exitCode: number, closes: boolean) => void) => () => void
  listDir: (paneId: string, dir: string) => Promise<FsEntry[]>
  localPrompt: (paneId: string) => Promise<boolean>
  onSize: (paneId: string, cb: (cols: number, rows: number) => void) => () => void
  onRun: (cb: (paneId: string, command: string) => void) => () => void
}

export interface ManagerOpenPaneRequest {
  agent: string
  cwd: string
}

export interface ManagerApi {
  onOpen: (cb: (req: ManagerOpenPaneRequest) => string | null) => () => void
}

export interface FsEntry {
  name: string
  dir: boolean
}

export interface FsApi {
  list: (path: string) => Promise<FsEntry[]>
  read: (path: string) => Promise<string | null>
  write: (path: string, content: string) => Promise<boolean>
  stat: (path: string) => Promise<FsKind | null>
  readBinary: (path: string) => Promise<FsBinaryResult>
  watch: (path: string) => Promise<boolean>
  unwatch: (path: string) => void
  onChanged: (cb: (change: { path: string; exists: boolean }) => void) => () => void
}

export interface RemoteFilesApi {
  folders: () => Promise<RemoteFolder[]>
  onFolders: (cb: (folders: RemoteFolder[]) => void) => () => void
  close: (folderId: string) => Promise<boolean>
  onConfirm: (cb: (ask: RemoteFolderAsk) => Promise<boolean>) => () => void
  list: (path: string) => Promise<RemoteListResult>
  stat: (path: string) => Promise<RemoteStatResult>
  read: (path: string) => Promise<RemoteReadResult>
  write: (path: string, content: string, baseVersion: string) => Promise<RemoteWriteResult>
}

export type FsBinaryResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; error: 'denied' | 'unreadable' }
  | { ok: false; error: 'too-large'; size: number }

export type FsKind = 'file' | 'dir'

export interface SettingsApi {
  path: () => Promise<string>
  onChanged: (cb: () => void) => () => void
}

export interface SyncConflict {
  id: string
  kind: 'setting' | 'file' | 'secret'
  key: string
  local: string | null
  remote: string | null
  winner: 'local' | 'remote'
  localAt?: number
  remoteAt?: number
}

export interface SyncOffer {
  id: string
  marketplace: string
}

export interface SyncStatus {
  dir: string | null
  state: 'off' | 'ok' | 'error'
  error?: string
  lastSync: string | null
  conflicts: SyncConflict[]
  skipped: string[]
  heldBack: string[]
  offers: SyncOffer[]
  secrets: SecretSyncStatus
}

export interface SecretSyncStatus {
  state: 'off' | 'needs-setup' | 'locked' | 'unlocked' | 'damaged'
  logins: boolean
}

export interface SecretActionResult {
  ok: boolean
  error?: string
  recoveryKey?: string
  status: SyncStatus
}

export type SecretReveal =
  | { ok: true; local: string | null; remote: string | null; winner: 'local' | 'remote' }
  | { ok: false }

export interface SecretSyncApi {
  reveal: (conflictId: string) => Promise<SecretReveal>
  enable: () => Promise<SecretActionResult>
  disable: () => Promise<SecretActionResult>
  remove: () => Promise<SecretActionResult>
  setLogins: (on: boolean) => Promise<SecretActionResult>
  setup: (password: string, confirm: string) => Promise<SecretActionResult>
  reset: (password: string, confirm: string) => Promise<SecretActionResult>
  unlock: (password: string) => Promise<SecretActionResult>
  changePassword: (password: string, confirm: string) => Promise<SecretActionResult>
  recover: (recoveryKey: string, password: string, confirm: string) => Promise<SecretActionResult>
}

export interface SyncApi {
  status: () => Promise<SyncStatus>
  run: () => Promise<SyncStatus>
  resolve: (conflictId: string) => Promise<SyncStatus>
  install: (extId: string) => Promise<SyncStatus>
  secrets: SecretSyncApi
  pickFolder: () => Promise<string | null>
  onStatus: (cb: (status: SyncStatus) => void) => () => void
}

export type WorkspaceLiveState = 'idle' | 'working' | 'waiting' | 'done' | 'error'

export type AttentionState = 'none' | 'working' | 'waiting' | 'done' | 'error'

export const NOTIFICATION_KINDS = ['waiting', 'approval', 'done', 'error', 'message'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export function notificationKindOf(value: unknown): NotificationKind {
  return NOTIFICATION_KINDS.includes(value as NotificationKind)
    ? (value as NotificationKind)
    : 'message'
}

export interface NotificationEntry {
  id: string
  ts: string
  kind: NotificationKind
  title: string
  body?: string
  from: string
  paneId?: string
  extId?: string
  panelPath?: string
}

export interface NotificationPost {
  paneId: string
  kind: NotificationKind
  title: string
  body?: string
  desktop: boolean
}

export interface NotificationsApi {
  list: () => Promise<NotificationEntry[]>
  post: (post: NotificationPost) => void
  clear: () => void
  onChanged: (cb: () => void) => () => void
  onActivate: (cb: (paneId: string) => void) => () => void
  reveal: (paneId: string) => void
}

export type SnapshotSurfaceKind =
  | 'terminal'
  | 'editor'
  | 'agent'
  | 'browser'
  | 'extension'
  | 'chat'
  | 'view'

export interface SnapshotPaneNode {
  type: 'pane'
  id: string
  title: string
  kind: SnapshotSurfaceKind
  cwd?: string
  filePath?: string
  url?: string
  extensionId?: string
  chatSessionId?: string
  viewName?: string
  browserProfile?: BrowserProfile
  resume?: AgentResume
  agentRunning?: true
  hibernated?: true
  locked?: true
  defaultTitle?: true
  titlePinned?: true
}

export interface SnapshotSplitNode {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  children: SnapshotNode[]
  sizes: number[]
}

export interface SnapshotTabsNode {
  type: 'tabs'
  id: string
  children: SnapshotPaneNode[]
  activeId: string
}

export type SnapshotNode = SnapshotPaneNode | SnapshotSplitNode | SnapshotTabsNode

export interface SnapshotWorkspace {
  id: string
  name: string
  customName?: string
  description?: string
  pinned?: boolean
  groupId?: string
  kind: 'agent' | 'terminal' | 'scratch'
  workDir: string
  projectDir?: string
  anchored?: true
  root?: SnapshotNode
  activePaneId?: string
  origin?: WorkspaceOrigin
}

export type PanePlacementZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface PanePlacement {
  paneId: string
  zone: PanePlacementZone
}

export interface WorkspaceOrigin {
  workspaceId: string
  index: number
  groupId?: string
  beside?: PanePlacement
}

export interface SnapshotGroup {
  id: string
  name: string
  color?: WorkspaceGroupColor
  collapsed?: boolean
}

export interface AppSnapshot {
  v: 1
  savedAt: string
  activeWorkspaceId: string | null
  workspaces: SnapshotWorkspace[]
  groups: SnapshotGroup[]
  windows?: SnapshotWindow[]
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapshotWindow {
  id: string
  bounds: WindowBounds
  activeWorkspaceId: string | null
  workspaces: SnapshotWorkspace[]
}

export interface WindowInfo {
  windowId: string
  detached: boolean
}

export interface WindowPaneSummary {
  id: string
  title: string
}

export interface WindowWorkspaceSummary {
  id: string
  name: string
  workDir: string
  state: WorkspaceLiveState
  unreadAt: number
  panes: WindowPaneSummary[]
}

export interface WindowSummary {
  windowId: string
  detached: boolean
  workspaces: WindowWorkspaceSummary[]
}

export type PaneAgentKind = ResumableAgent | 'other'

export interface WindowPaneReport extends WindowPaneSummary {
  agent?: PaneAgentKind
  state?: AttentionState
  cwd?: string
}

export interface WindowWorkspaceReport extends WindowWorkspaceSummary {
  origin?: string
  panes: WindowPaneReport[]
}

export interface OriginAgentTarget {
  paneId: string
  title: string
  agent: PaneAgentKind
  state: AttentionState
  cwd?: string
}

export interface OriginAgents {
  workspaceId: string
  workspaceName: string
  targets: OriginAgentTarget[]
}

export interface OriginReferenceRequest {
  workspaceId: string
  paneId: string
  text: string
  note?: string
}

export interface ReferenceInsert {
  requestId: string
  paneId: string
  text: string
  note?: string
}

export interface NewWorkspaceRequest {
  dir?: string
  name?: string
  scratch?: boolean
  sandboxed?: boolean
}

export interface ScratchApi {
  create: () => Promise<string | null>
  files: (workspaceId: string) => Promise<number>
  reveal: (workspaceId: string) => void
}

export interface ScreenPoint {
  x: number
  y: number
}

export interface PaneDrop {
  paneId: string
  workspaceId: string
  placement: PanePlacement
}

export interface WindowsApi {
  info: () => Promise<WindowInfo>
  detach: (workspace: SnapshotWorkspace, at?: ScreenPoint) => Promise<boolean>
  dropPane: (drop: PaneDrop) => void
  landing: (paneId: string) => Promise<boolean>
  give: (workspace: SnapshotWorkspace) => Promise<boolean>
  returnToMain: (workspaces: SnapshotWorkspace[]) => Promise<boolean>
  openWith: (workspaces: SnapshotWorkspace[]) => Promise<boolean>
  report: (workspaces: WindowWorkspaceReport[]) => void
  focusWorkspace: (workspaceId: string, jumpToUnread: boolean) => void
  returnWorkspace: (workspaceId: string) => void
  newWorkspace: (request: NewWorkspaceRequest) => void
  onList: (cb: (list: WindowSummary[]) => void) => () => void
  onAdopt: (cb: (workspaces: SnapshotWorkspace[]) => void) => () => void
  onActivateWorkspace: (cb: (workspaceId: string, jumpToUnread: boolean) => void) => () => void
  onReturnRequest: (cb: () => void) => () => void
  originAgents: (workspaceId: string) => Promise<OriginAgents | null>
  onOriginAgentsChanged: (cb: () => void) => () => void
  insertReference: (request: OriginReferenceRequest) => Promise<boolean>
  onInsertReference: (cb: (insert: ReferenceInsert) => void) => () => void
  answerInsertReference: (requestId: string, inserted: boolean) => void
}

export type WorkspaceMergeError = 'not-owned' | 'manager' | SandboxMergeRefusal

export type WorkspaceMergeResult = { ok: true } | { ok: false; error: WorkspaceMergeError }

export interface WorkspaceApi {
  save: (snapshot: AppSnapshot | null) => void
  load: () => Promise<AppSnapshot | null>
  merge: (sourceId: string, targetId: string) => Promise<WorkspaceMergeResult>
  readCmux: (path?: string) => Promise<CmuxSessionRead>
}

export type LifecycleEvent =
  | { type: 'pane-created'; workspaceId: string; paneId: string }
  | { type: 'pane-closed'; workspaceId: string; paneId: string }
  | { type: 'workspace-added'; workspaceId: string; workDir: string }
  | { type: 'workspace-closed'; workspaceId: string }
  | { type: 'workspace-activated'; workspaceId: string }
  | { type: 'workspace-state'; workspaceId: string; state: WorkspaceLiveState }

export interface LifecycleApi {
  emit: (event: LifecycleEvent) => void
}

export type JSONSchema = Record<string, unknown>

export type TargetMode = 'active' | 'explicit' | 'none'

export type CommandErrorCode = 'unknown-command' | 'command-failed' | 'needs-elevation'

export interface CommandError {
  code: CommandErrorCode
  message: string
}

export type CommandResult<R = unknown> =
  | { ok: true; result: R }
  | { ok: false; error: CommandError }

export interface CommandDescriptor {
  id: string
  title: string
  category: string | null
  hidden: boolean
  argsSchema: JSONSchema | null
  resultSchema: JSONSchema | null
  capabilities: Capability[]
  target: TargetMode
}

export interface CommandTarget {
  windowId?: string
  workspaceId: string
  paneId: string | null
}

export interface CommandInvokeRequest {
  id: string
  args?: unknown
  target: CommandTarget
}

export interface CommandsApi {
  publish: (descriptors: CommandDescriptor[]) => void
  onInvoke: (handler: (req: CommandInvokeRequest) => Promise<CommandResult>) => () => void
}

export interface AppMenuApi {
  set: (spec: AppMenuSpec) => void
  onRun: (cb: (command: string) => void) => () => void
}

export interface TerminalStateSnapshot {
  paneId: string
  generation: number
  cwd?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
  remote?: RemoteCwd
}

export interface TerminalStateApi {
  push: (snapshot: TerminalStateSnapshot) => void
}

export interface BrowserApi {
  claimProfile: (paneId: string, profile: BrowserProfile) => Promise<BrowserProfile>
  register: (paneId: string, webContentsId: number) => void
  unregister: (paneId: string) => void
  pickStart: (paneId: string, theme: PickTheme) => Promise<PickOutcome>
  pickCancel: (paneId: string) => void
  pickSend: (req: PickSendRequest) => Promise<PickSendResult>
  onPickState: (cb: (state: PickState) => void) => () => void
  regionCapture: (paneId: string, req: RegionCaptureRequest) => Promise<RegionCaptureOutcome>
  regionSend: (req: RegionSendRequest) => Promise<PickSendResult>
  regionCopy: (paneId: string, captureId: string) => Promise<RegionCopyResult>
  storageRead: (paneId: string) => Promise<BrowserStorageRead>
  storageSet: (paneId: string, edit: StorageEdit) => Promise<StorageWriteResult>
  storageRemove: (paneId: string, removal: StorageRemoval) => Promise<StorageWriteResult>
  storageClear: (paneId: string, kind: StorageKind) => Promise<StorageWriteResult>
}

export interface SelectionApi {
  send: (req: SelectionSendRequest) => Promise<SelectionSendResult>
}

export interface WorkspaceProject {
  name: string
  display: string
  dir: string
  repo: boolean
}

export type OpenPathResult = { ok: true } | { ok: false; error: 'not-found' | 'program' | 'failed' }

export interface FilesApi {
  pathForFile: (file: File) => string
  admitDropped: (files: File[], workspaceId: string | null) => Promise<OpenFileVerdict[]>
}

export interface ClipboardApi {
  edit: (edit: ClipboardEdit) => Promise<void>
  hasImage: () => Promise<boolean>
  setChords: (chords: ClipboardChords) => void
}

export interface GuestChordsApi {
  set: (signatures: string[]) => void
  onFire: (cb: (fire: GuestChordFire) => void) => () => void
}

export interface OpenPathApi {
  openDefault: (path: string) => Promise<OpenPathResult>
  reveal: (path: string) => Promise<OpenPathResult>
  project: (dir: string, exact?: boolean) => Promise<WorkspaceProject | null>
}

export interface AgentSessionApi {
  info: (resume: AgentResume) => Promise<AgentSessionInfo | null>
}

export interface AppUpdateApi {
  state: () => Promise<BuildInfo | null>
  restart: () => Promise<void>
  onAvailable: (cb: (info: BuildInfo) => void) => () => void
  release: () => Promise<ReleaseInfo | null>
  checkRelease: () => Promise<ReleaseCheckResult>
  openRelease: () => Promise<boolean>
  dismissRelease: () => Promise<void>
  onRelease: (cb: (release: ReleaseInfo | null) => void) => () => void
}

export type CredentialFillResult =
  | { ok: true; username: string }
  | { ok: false; error: 'no-login' | 'no-form' | 'origin-changed' | 'locked' }

export interface CredentialsApi {
  forPage: (paneId: string) => Promise<CredentialSummary[]>
  fill: (paneId: string, id: string) => Promise<CredentialFillResult>
  saveFromPage: (paneId: string) => Promise<CredentialSaveResult>
  list: () => Promise<CredentialSummary[]>
  save: (input: CredentialInput) => Promise<CredentialSaveResult>
  remove: (id: string) => Promise<boolean>
  copyPassword: (id: string) => Promise<boolean>
  import: () => Promise<CredentialImportResult>
}

export interface ApprovalsApi {
  state: () => Promise<ApprovalState>
  answer: (id: string, answer: ApprovalAnswer) => Promise<boolean>
  revoke: (id: string) => Promise<boolean>
  onChange: (cb: (state: ApprovalState) => void) => () => void
}

export interface QuestionsApi {
  state: () => Promise<QuestionState>
  answer: (id: string, reply: QuestionReply) => Promise<boolean>
  dismiss: (id: string) => Promise<boolean>
  onChange: (cb: (state: QuestionState) => void) => () => void
}

export type GatewayTailnetState =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'needs-login'; authUrl: string }
  | { state: 'running'; ip: string | null; dnsName: string | null }
  | { state: 'error'; code: string }

export interface GatewayStatus {
  running: boolean
  host: string | null
  port: number | null
  fingerprint: string | null
  deviceCount: number
}

export interface GatewayRemoteStatus extends GatewayStatus {
  tailnet: GatewayTailnetState
}

export interface GatewayPairResult {
  v: 1
  host: string
  port: number
  fingerprint: string
  pairCode: string
  name: string
}

export type GatewayPairResponse = GatewayPairResult | { error: 'not-running' }

export type GatewayTailnetActionResult =
  | { ok: true }
  | { ok: false; error: 'not-a-window' | 'no-login-link' | 'login-link-refused' }

export interface GatewayDevice {
  deviceId: string
  name: string
  pubkey: string
  caps: string[]
  createdAt: string
}

export type GatewaySetCapResult =
  | { ok: true; caps: string[] }
  | { ok: false; error: 'not-found' | 'invalid-cap' | 'requires-command' }

export interface GatewayApi {
  enable: () => Promise<GatewayRemoteStatus>
  disable: () => Promise<GatewayRemoteStatus>
  pair: () => Promise<GatewayPairResponse>
  status: () => Promise<GatewayRemoteStatus>
  devices: () => Promise<{ devices: GatewayDevice[] }>
  revoke: (deviceId: string) => Promise<{ ok: boolean; error?: string }>
  setCap: (
    deviceId: string,
    cap: PhoneGrantableCap,
    granted: boolean,
  ) => Promise<GatewaySetCapResult>
  tailnetSignIn: () => Promise<GatewayTailnetActionResult>
  tailnetSignOut: () => Promise<GatewayTailnetActionResult>
  onTailnetChanged: (cb: (state: GatewayTailnetState) => void) => () => void
}

export interface ExternalEditorRequest {
  template: string
  file: string
  line?: number
  column?: number
}

export type ExternalEditorResult =
  | { ok: true; argv: string[] }
  | {
      ok: false
      error: 'invalid-path' | 'no-editor' | 'invalid-template' | 'spawn-failed'
      message?: string
    }

export interface ExternalEditorApi {
  open: (req: ExternalEditorRequest) => Promise<ExternalEditorResult>
}

export interface CompletionsApi {
  spec: (command: string) => Promise<SpecCommand | null>
}

export interface WorkflowsApi {
  list: (workspaceId: string | null) => Promise<WorkflowListing>
  save: (doc: WorkflowDocument) => Promise<WorkflowSaveResult>
}

export interface OstiaBridge {
  ping: () => Promise<'pong'>
  info: () => Promise<AppInfo>
  platform: Platform
  window: WindowControls
  diagnostics: DiagnosticsApi
  pty: PtyApi
  manager: ManagerApi
  fs: FsApi
  search: SearchApi
  remoteFiles: RemoteFilesApi
  lsp: LspApi
  settings: SettingsApi
  sync: SyncApi
  workspace: WorkspaceApi
  scratch: ScratchApi
  windows: WindowsApi
  lifecycle: LifecycleApi
  commands: CommandsApi
  appMenu: AppMenuApi
  terminalState: TerminalStateApi
  browser: BrowserApi
  selection: SelectionApi
  approvals: ApprovalsApi
  questions: QuestionsApi
  credentials: CredentialsApi
  sandbox: SandboxApi
  secrets: SecretsApi
  system: SystemApi
  update: AppUpdateApi
  agentSession: AgentSessionApi
  openPath: OpenPathApi
  clipboard: ClipboardApi
  guestChords: GuestChordsApi
  files: FilesApi
  extensions: ExtensionsApi
  fileOps: FileOpsApi
  marketplace: MarketplaceApi
  suggestions: SuggestionsApi
  externalEditor: ExternalEditorApi
  gateway: GatewayApi
  notifications: NotificationsApi
  workflows: WorkflowsApi
  completions: CompletionsApi
  assist: AssistApi & { wake: () => void }
  chatSessions: ChatSessionsApi
  privacy: PrivacyApi
  chatTools: ChatToolsApi
  iconThemes: IconThemesApi
  languagePacks: LanguagePacksApi
  keymaps: KeymapsApi
  editorLanguages: EditorLanguagesApi
  views: ViewsApi
}

declare global {
  interface Window {
    ostia: OstiaBridge
  }
}
