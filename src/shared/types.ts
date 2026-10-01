import type { AgentResume } from './agentResume'
import type { AgentSessionInfo } from './agentSessionInfo'
import type { ApprovalAnswer, ApprovalState } from './approvals'
import type { AssistApi } from './assist'
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
import type { SpecCommand } from './completionSpec'
import type {
  CredentialImportResult,
  CredentialInput,
  CredentialSaveResult,
  CredentialSummary,
} from './credentials'
import type { ExtensionResult, ExtensionsApi } from './extensions'
import type { IconThemesApi } from './iconTheme'
import type { PickOutcome, PickSendRequest, PickSendResult, PickState, PickTheme } from './pick'
import type { PromptSeparator } from './promptSettings'
import type {
  DomainRefusal,
  PortsPolicy,
  SandboxControls,
  SandboxEditResult,
  SandboxExposeResult,
  SandboxPortRow,
  WorkspacePackages,
  WorkspaceSandbox,
} from './sandbox'
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
}

export interface WindowControls {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  quit: () => void
  isMaximized: () => Promise<boolean>
  setZoom: (percent: number) => Promise<number>
  isSystemDark: () => Promise<boolean>
  onSystemDarkChange: (cb: (dark: boolean) => void) => () => void
  onMaximizeChange: (cb: (maximized: boolean) => void) => () => void
  onRunningQuery: (cb: () => RunningGroup[]) => () => void
  onConfirmClose: (cb: (groups: RunningGroup[]) => Promise<boolean>) => () => void
  onFreeze: (cb: () => void) => () => void
}

export interface RunningGroup {
  workspaceId: string
  workspace: string
  commands: string[]
  files: string[]
}

export interface PtySpawnOptions {
  cwd?: string
  cols: number
  rows: number
  shell?: string
  role?: 'owner' | 'observer'
  sinceCursor?: number
  pinePrompt?: PinePromptSpawn
  workspaceId?: string
  hostToken?: string
  attachOnly?: boolean
}

export interface PinePromptSpawn {
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
  sandboxed?: boolean
  host?: boolean
  cols?: number
  rows?: number
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
  setEnabled: (workspaceId: string, enabled: boolean) => Promise<WorkspaceSandbox | null>
  setAllowRead: (workspaceId: string, paths: string[]) => Promise<SandboxEditResult>
  setDomains: (workspaceId: string, domains: string[]) => Promise<SandboxEditResult>
  setControls: (
    workspaceId: string,
    controls: Partial<SandboxControls>,
  ) => Promise<WorkspaceSandbox | null>
  refusals: (workspaceId: string) => Promise<DomainRefusal[]>
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
  promptContext: (paneId: string, want: PromptContextRequest) => Promise<PromptContext | null>
  onData: (paneId: string, cb: (data: string) => void) => () => void
  onExit: (paneId: string, cb: (exitCode: number) => void) => () => void
  onSize: (paneId: string, cb: (cols: number, rows: number) => void) => () => void
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

export type FsBinaryResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; error: 'denied' | 'unreadable' }
  | { ok: false; error: 'too-large'; size: number }

export type FsKind = 'file' | 'dir'

export interface LspStartResult {
  id: string
  root: string
}

export interface LspServerInfo {
  languageId: string
  command: string
  installed: boolean
}

export interface LspApi {
  list: () => Promise<LspServerInfo[]>
  start: (languageId: string, filePath: string) => Promise<LspStartResult | null>
  send: (id: string, message: unknown) => void
  stop: (id: string) => void
  onMessage: (id: string, cb: (message: unknown) => void) => () => void
  onExit: (id: string, cb: () => void) => () => void
}

export interface SettingsApi {
  path: () => Promise<string>
  onChanged: (cb: () => void) => () => void
}

export interface SyncConflict {
  at: string
  files: string[]
}

export interface SyncStatus {
  dir: string | null
  state: 'off' | 'ok' | 'error'
  error?: string
  lastSync: string | null
  lastConflict: SyncConflict | null
}

export interface SyncApi {
  status: () => Promise<SyncStatus>
  run: () => Promise<SyncStatus>
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
  resume?: AgentResume
  agentRunning?: true
  hibernated?: true
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
  root?: SnapshotNode
  activePaneId?: string
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

export interface NewWorkspaceRequest {
  dir?: string
  name?: string
}

export interface WindowsApi {
  info: () => Promise<WindowInfo>
  detach: (workspace: SnapshotWorkspace) => Promise<boolean>
  returnToMain: (workspaces: SnapshotWorkspace[]) => Promise<boolean>
  report: (workspaces: WindowWorkspaceSummary[]) => void
  focusWorkspace: (workspaceId: string, jumpToUnread: boolean) => void
  returnWorkspace: (workspaceId: string) => void
  newWorkspace: (request: NewWorkspaceRequest) => void
  onList: (cb: (list: WindowSummary[]) => void) => () => void
  onAdopt: (cb: (workspaces: SnapshotWorkspace[]) => void) => () => void
  onActivateWorkspace: (cb: (workspaceId: string, jumpToUnread: boolean) => void) => () => void
  onReturnRequest: (cb: () => void) => () => void
}

export interface WorkspaceApi {
  save: (snapshot: AppSnapshot | null) => void
  load: () => Promise<AppSnapshot | null>
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

export interface TerminalStateSnapshot {
  paneId: string
  generation: number
  cwd?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
}

export interface TerminalStateApi {
  push: (snapshot: TerminalStateSnapshot) => void
}

export interface BrowserApi {
  register: (paneId: string, webContentsId: number) => void
  unregister: (paneId: string) => void
  pickStart: (paneId: string, theme: PickTheme) => Promise<PickOutcome>
  pickCancel: (paneId: string) => void
  pickSend: (req: PickSendRequest) => Promise<PickSendResult>
  onPickState: (cb: (state: PickState) => void) => () => void
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
}

export type OpenPathResult = { ok: true } | { ok: false; error: 'not-found' | 'program' | 'failed' }

export interface FilesApi {
  pathForFile: (file: File) => string
}

export interface OpenPathApi {
  openDefault: (path: string) => Promise<OpenPathResult>
  reveal: (path: string) => Promise<OpenPathResult>
  project: (dir: string) => Promise<WorkspaceProject | null>
}

export interface AgentSessionApi {
  info: (resume: AgentResume) => Promise<AgentSessionInfo | null>
}

export interface AppUpdateApi {
  state: () => Promise<BuildInfo | null>
  restart: () => Promise<void>
  onAvailable: (cb: (info: BuildInfo) => void) => () => void
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

export interface GatewayStatus {
  running: boolean
  host: string | null
  port: number | null
  fingerprint: string | null
  deviceCount: number
}

export interface GatewayEnableResult {
  host: string
  port: number
  fingerprint: string
  warning?: string
}

export interface GatewayPairResult {
  v: 1
  host: string
  port: number
  fingerprint: string
  pairCode: string
  name: string
  warning?: string
}

export interface GatewayDevice {
  deviceId: string
  name: string
  pubkey: string
  caps: string[]
  createdAt: string
}

export type GatewayBindKind = 'loopback' | 'lan' | 'tailscale' | 'custom'

export interface GatewayBindAddress {
  address: string
  kind: GatewayBindKind
  iface?: string
}

export interface GatewayBindOptions {
  addresses: GatewayBindAddress[]
  selected: string
}

export type GatewaySetCapResult =
  | { ok: true; caps: string[] }
  | { ok: false; error: 'not-found' | 'invalid-cap' | 'requires-command' }

export interface GatewayApi {
  enable: (opts?: { host?: string; port?: number }) => Promise<GatewayEnableResult>
  disable: () => Promise<{ ok: true }>
  pair: () => Promise<GatewayPairResult>
  status: () => Promise<GatewayStatus>
  devices: () => Promise<{ devices: GatewayDevice[] }>
  revoke: (deviceId: string) => Promise<{ ok: boolean; error?: string }>
  setCap: (
    deviceId: string,
    cap: PhoneGrantableCap,
    granted: boolean,
  ) => Promise<GatewaySetCapResult>
  bindOptions: () => Promise<GatewayBindOptions>
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

export interface PineBridge {
  ping: () => Promise<'pong'>
  info: () => Promise<AppInfo>
  platform: Platform
  window: WindowControls
  pty: PtyApi
  manager: ManagerApi
  fs: FsApi
  lsp: LspApi
  settings: SettingsApi
  sync: SyncApi
  workspace: WorkspaceApi
  windows: WindowsApi
  lifecycle: LifecycleApi
  commands: CommandsApi
  terminalState: TerminalStateApi
  browser: BrowserApi
  selection: SelectionApi
  approvals: ApprovalsApi
  credentials: CredentialsApi
  sandbox: SandboxApi
  secrets: SecretsApi
  system: SystemApi
  update: AppUpdateApi
  agentSession: AgentSessionApi
  openPath: OpenPathApi
  files: FilesApi
  extensions: ExtensionsApi
  externalEditor: ExternalEditorApi
  gateway: GatewayApi
  notifications: NotificationsApi
  workflows: WorkflowsApi
  completions: CompletionsApi
  assist: AssistApi
  chatSessions: ChatSessionsApi
  chatTools: ChatToolsApi
  iconThemes: IconThemesApi
  views: ViewsApi
}

declare global {
  interface Window {
    pine: PineBridge
  }
}
