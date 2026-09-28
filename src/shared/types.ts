import type { AgentResume } from './agentResume'
import type { Capability, PhoneGrantableCap } from './capabilities'
import type { ExtensionsApi } from './extensions'
import type { PickOutcome, PickSendRequest, PickSendResult, PickState, PickTheme } from './pick'

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
  isMaximized: () => Promise<boolean>
  onMaximizeChange: (cb: (maximized: boolean) => void) => () => void
}

export interface PtySpawnOptions {
  cwd?: string
  cols: number
  rows: number
  shell?: string
  role?: 'owner' | 'observer'
  sinceCursor?: number
}

export interface PtyAttachResult {
  created: boolean
  buffer: string
  cursor: number
  dropped: boolean
}

export interface PtyApi {
  attach: (paneId: string, opts: PtySpawnOptions) => Promise<PtyAttachResult>
  detach: (paneId: string) => void
  write: (paneId: string, data: string) => void
  resize: (paneId: string, cols: number, rows: number) => void
  onData: (paneId: string, cb: (data: string) => void) => () => void
  onExit: (paneId: string, cb: (exitCode: number) => void) => () => void
}

export interface FsEntry {
  name: string
  dir: boolean
}

export interface FsApi {
  list: (path: string) => Promise<FsEntry[]>
  read: (path: string) => Promise<string | null>
  write: (path: string, content: string) => Promise<boolean>
}

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

export interface NotificationEntry {
  id: string
  ts: string
  title: string
  body?: string
  from: string
  paneId?: string
  extId?: string
}

export interface NotificationPost {
  paneId: string
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
}

export type SnapshotSurfaceKind = 'terminal' | 'editor' | 'agent' | 'browser' | 'extension'

export interface SnapshotPaneNode {
  type: 'pane'
  id: string
  title: string
  kind: SnapshotSurfaceKind
  cwd?: string
  filePath?: string
  url?: string
  extensionId?: string
  resume?: AgentResume
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
  kind: 'agent' | 'terminal' | 'scratch'
  workDir: string
  root?: SnapshotNode
  activePaneId?: string
}

export interface AppSnapshot {
  v: 1
  savedAt: string
  activeWorkspaceId: string | null
  workspaces: SnapshotWorkspace[]
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

export interface PineBridge {
  ping: () => Promise<'pong'>
  info: () => Promise<AppInfo>
  platform: Platform
  window: WindowControls
  pty: PtyApi
  fs: FsApi
  lsp: LspApi
  settings: SettingsApi
  sync: SyncApi
  workspace: WorkspaceApi
  lifecycle: LifecycleApi
  commands: CommandsApi
  terminalState: TerminalStateApi
  browser: BrowserApi
  extensions: ExtensionsApi
  externalEditor: ExternalEditorApi
  gateway: GatewayApi
  notifications: NotificationsApi
}

declare global {
  interface Window {
    pine: PineBridge
  }
}
