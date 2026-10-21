import { once } from 'node:events'
import { createConnection } from 'node:net'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import type {
  AgentEvent,
  AgentReply,
  AgentRequest,
  AgentToolCall,
  AgentToolReply,
} from '../contract/agent'
import { readEnv } from '../contract/appEnv'
import type {
  AssistModelList,
  AssistPoint,
  AssistProviderEntry,
  AssistReport,
  AssistRequests,
  AssistResults,
  AssistUi,
} from '../contract/assist'
import type { Capability } from '../contract/capabilities'
import { apiProblem, EXTENSION_API_ENV } from '../contract/extensionApi'
import type {
  AgentOfferOptions,
  AgentOfferResult,
  DiffContent,
  ExtensionCaller,
  ExtensionEventPayloads,
  ExtensionEventType,
  ExtensionIcon,
  ExtensionResult,
  ExtensionSettingValue,
  ExtensionSettingValues,
  InboxActionEvent,
  InboxItem,
  OpenTerminalOptions,
  PaneChipItem,
  PanelToolbarState,
  RunAgentOptions,
  SandboxDomainsResult,
  SidebarKind,
  SidebarTone,
  TerminalWait,
  WireRuntimeResult,
} from '../contract/extensions'
import type {
  RemoteFilesRequest,
  RemoteListResult,
  RemoteReadResult,
  RemoteStatResult,
  RemoteWriteResult,
} from '../contract/remoteFolders'
import type { BrowseProvider } from './browse'
import { declaredApi } from './declaredApi'
import { agentMethods, serviceMethods, windowMethods } from './extensionMethods'
import { createHostHandlers, listenToHost } from './hostHandlers'
import { type PhoneScreens, phoneScreenMethods } from './phoneScreens'
import type {
  AgentCompleteOptions,
  AgentCompleteResult,
  AskOptions,
  AskResult,
  BusSendResult,
  CallerCapsResult,
  ConnectionResult,
  ConnectionsResult,
  ExecOptions,
  ExecResult,
  McpCallReply,
  McpServersResult,
  ParkedActResult,
  ParkedListResult,
  WakePaneResult,
} from './workApi'

export { type AgentStop, parseAgentStop } from '../contract/agentStop'
export type { ConnectionInfo, ConnectionValue } from '../contract/extensionConnections'
export {
  formatMessage,
  localized,
  type MessageVars,
  matchLocale,
  type Translate,
} from '../contract/extensionLocales'

export type {
  AgentOfferOptions,
  AgentOfferResult,
  DiffContent,
  ExtensionCaller,
  ExtensionEventType,
  ExtensionIcon,
  ExtensionResult,
  ExtensionSettingValues,
  InboxActionEvent,
  InboxItem,
  OpenTerminalOptions,
  PaneChipItem,
  PanelToolbarState,
  RunAgentOptions,
  SandboxDomainsResult,
  SidebarTone,
  TerminalWait,
  TerminalWaitOutcome,
  WireRuntimeResult,
} from '../contract/extensions'

export {
  EXTENSION_REDACT_TEXT_MAX,
  EXTENSION_REDACT_TEXTS_MAX,
  OPEN_TERMINAL_WAIT_MAX_MS,
} from '../contract/extensions'
export type {
  RemoteCwd,
  RemoteEntry,
  RemoteFileError,
  RemoteFilesOp,
  RemoteFilesRequest,
  RemoteListResult,
  RemoteReadResult,
  RemoteStatResult,
  RemoteWriteResult,
} from '../contract/remoteFolders'
export {
  REMOTE_ENTRIES_MAX,
  REMOTE_FILE_MAX_BYTES,
  REMOTE_WRITE_ANY,
  REMOTE_WRITE_NEW,
} from '../contract/remoteFolders'
export { createTranslator } from './i18n'
export type {
  AgentCompleteOptions,
  AgentCompleteResult,
  AskOptions,
  AskResult,
  BusSendResult,
  CallerCapsResult,
  ConnectionResult,
  ConnectionsResult,
  ExecOptions,
  ExecResult,
  McpCallReply,
  McpServerInfo,
  McpServersResult,
  ParkedActResult,
  ParkedItem,
  ParkedListResult,
  WakePaneOutcome,
  WakePaneResult,
} from './workApi'

export type RemoteFilesResult =
  | RemoteListResult
  | RemoteStatResult
  | RemoteReadResult
  | RemoteWriteResult

export type FilesHandler = (
  req: RemoteFilesRequest,
) => RemoteFilesResult | Promise<RemoteFilesResult>

export type FolderClosedHandler = (folderId: string) => void

export interface OpenFolderOptions {
  workspaceId: string
  host: string
  path: string
}

export type OpenFolderResult =
  | { ok: true; folderId: string }
  | { ok: false; error: string; message?: string }

export interface OpenFileOptions {
  workspaceId: string
  path: string
  line?: number
  column?: number
}

export type AttentionVerb = 'waiting' | 'done' | 'working' | 'error' | 'clear'

export interface ChipValue {
  id: string
  text: string
  tooltip?: string
  tone?: SidebarTone
  icon?: ExtensionIcon
  items?: PaneChipItem[]
  command?: string
  url?: string
}

export interface PaneChipValue extends ChipValue {
  paneId: string
}

export interface WorkspaceChipValue extends ChipValue {
  workspaceId: string
}

export type OpenTerminalResult =
  | { ok: true; paneId: string; wait?: TerminalWait }
  | { ok: false; error: string; message?: string }

export interface WorkspaceInfo {
  workspaceId: string
  name: string
  kind: string
  workDir: string
  state: string
  activePaneId?: string
  sandboxed?: boolean
}

export interface PaneInfo {
  paneId: string
  workspaceId: string
  kind: string
  title: string
  cwd?: string
  filePath?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
  pid?: number
  agent?: string
  agentSessionId?: string
  agentState?: PaneAgentState
  agentMessage?: string
  hibernated?: boolean
}

export type PaneAgentState = 'working' | 'waiting' | 'done' | 'error'

export type CommandHandler = (
  args: unknown,
  caller: ExtensionCaller,
) => ExtensionResult | Promise<ExtensionResult>

export type PanelHandler = (
  caller: ExtensionCaller,
  path?: string,
) => { url: string } | Promise<{ url: string }>

export type SettingsHandler = (values: ExtensionSettingValues) => void

export type LocaleHandler = (locale: string) => void

export interface AssistContext {
  requestId: string
  signal: AbortSignal
  chunk: (text: string) => Promise<boolean>
  model?: { provider: string; model: string }
}

export type AgentHandler = (request: AgentRequest) => Promise<AgentReply>

export type AssistProvidersHandler = (providers: AssistProviderEntry[]) => void

export type AssistHandler = <P extends AssistPoint>(
  point: P,
  input: AssistRequests[P],
  ctx: AssistContext,
) => Promise<AssistResults[P]>

export type EventHandler = <T extends ExtensionEventType>(
  type: T,
  payload: ExtensionEventPayloads[T],
) => void

export interface ConfirmRequest {
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  hostTerminal?: string[]
}

export interface OstiaExtension {
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>
  confirm: (req: ConfirmRequest) => Promise<boolean>
  notifyPanel: (title: string, body?: string, path?: string) => Promise<unknown>
  registerCommands: (handlers: Record<string, CommandHandler>) => Promise<void>
  onPanel: (handler: PanelHandler) => void
  subscribe: (events: ExtensionEventType[], handler: EventHandler) => Promise<unknown>
  setSidebarItem: (item: {
    key?: string
    workspaceId?: string
    text: string
    icon?: ExtensionIcon
    badge?: string
    tone?: SidebarTone
    kind?: SidebarKind
    url?: string
  }) => Promise<unknown>
  startWithWindow: (on: boolean) => Promise<ExtensionResult>
  wireRuntime: () => Promise<WireRuntimeResult>
  notify: (title: string, body?: string) => Promise<unknown>
  openPanel: (workspaceId?: string, path?: string) => Promise<unknown>
  setPanelToolbar: (
    toolbar: PanelToolbarState & { workspaceId: string },
  ) => Promise<ExtensionResult>
  setInboxItems: (workspaceId: string, items: InboxItem[]) => Promise<ExtensionResult>
  onInboxAction: (handler: (event: InboxActionEvent) => void) => void
  setPaneChip: (chip: PaneChipValue) => Promise<ExtensionResult>
  clearPaneChip: (paneId: string, id: string) => Promise<ExtensionResult>
  setWorkspaceChip: (chip: WorkspaceChipValue) => Promise<ExtensionResult>
  clearWorkspaceChip: (workspaceId: string, id: string) => Promise<ExtensionResult>
  getSettings: () => Promise<ExtensionSettingValues>
  setSetting: (key: string, value: ExtensionSettingValue | null) => Promise<ExtensionResult>
  onSettingsChanged: (handler: SettingsHandler) => void
  getLocale: () => Promise<string>
  onLocaleChanged: (handler: LocaleHandler) => void
  callAs: <T = unknown>(paneId: string, method: string, params?: object) => Promise<T>
  setAttention: (paneId: string, state: AttentionVerb, message?: string) => Promise<unknown>
  openDiff: (diff: DiffContent & { workspaceId?: string }) => Promise<ExtensionResult>
  openFile: (file: OpenFileOptions) => Promise<ExtensionResult>
  openTerminal: (opts: OpenTerminalOptions) => Promise<OpenTerminalResult>
  listAgents: () => Promise<string[]>
  runAgent: (opts: RunAgentOptions) => Promise<OpenTerminalResult>
  offerToAgent: (opts: AgentOfferOptions) => Promise<AgentOfferResult>
  focusPane: (paneId: string) => Promise<ExtensionResult>
  redact: (texts: string[]) => Promise<string[] | null>
  exec: (opts: ExecOptions, signal?: AbortSignal) => Promise<ExecResult>
  busSend: (to: string, text: string) => Promise<BusSendResult>
  wakePane: (paneId: string, waitMs?: number) => Promise<WakePaneResult>
  requireCallerCaps: (
    paneId: string,
    caps: Capability[],
    reason: string,
  ) => Promise<CallerCapsResult>
  playbookEnabled: () => Promise<boolean>
  ask: (opts: AskOptions, signal?: AbortSignal) => Promise<AskResult>
  mcpCall: (
    server: string,
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<McpCallReply>
  mcpServers: () => Promise<McpServersResult>
  onAgent: (handler: AgentHandler) => void
  agentEvent: (sessionId: string, event: AgentEvent) => Promise<void>
  agentTool: (call: AgentToolCall, signal?: AbortSignal) => Promise<AgentToolReply>
  agentComplete: (opts: AgentCompleteOptions, signal?: AbortSignal) => Promise<AgentCompleteResult>
  parkedList: (workspaceId: string) => Promise<ParkedListResult>
  parkedResume: (id: string) => Promise<ParkedActResult>
  parkedForget: (id: string) => Promise<ParkedActResult>
  connections: () => Promise<ConnectionsResult>
  connection: (name: string) => Promise<ConnectionResult>
  onConnectionsChanged: (handler: () => void) => void
  listWorkspaces: () => Promise<WorkspaceInfo[]>
  listPanes: () => Promise<PaneInfo[]>
  onAssist: (handler: AssistHandler) => void
  onAssistModels: (handler: AssistModelsHandler) => void
  setAssistStatus: (report: AssistReport) => Promise<unknown>
  getShortcuts: (ids: string[]) => Promise<Record<string, string | null>>
  openAssistUi: (ui: AssistUi, workspaceId?: string) => Promise<ExtensionResult>
  getSecret: (key: string) => Promise<string | null>
  getAssistProviders: () => Promise<AssistProviderEntry[]>
  onAssistProvidersChanged: (handler: AssistProvidersHandler) => void
  openFolder: (opts: OpenFolderOptions) => Promise<OpenFolderResult>
  closeFolder: (folderId: string) => Promise<ExtensionResult>
  onFiles: (handler: FilesHandler) => void
  onFolderClosed: (handler: FolderClosedHandler) => void
  onBrowse: (name: string, provider: BrowseProvider) => void
  sandboxDomains: (workspaceId: string) => Promise<SandboxDomainsResult>
  phoneScreens: PhoneScreens
}

export interface AssistModelsHandler {
  list: (provider?: string) => Promise<AssistModelList>
  setLoaded: (id: string, loaded: boolean, provider?: string) => Promise<void>
}

export { EXTENSION_API_VERSION } from '../contract/extensionApi'
export { PRODUCT_NAME } from '../contract/product'

export async function connect(): Promise<OstiaExtension> {
  const socketPath = readEnv('SOCKET')
  const token = readEnv('TOKEN')
  if (!socketPath || !token) throw new Error('OSTIA_SOCKET / OSTIA_TOKEN missing')
  const provided = readEnv(EXTENSION_API_ENV)
  const incompatible = provided ? apiProblem(declaredApi(), provided) : null
  if (incompatible) throw new Error(`this extension ${incompatible}`)
  const socket = createConnection(socketPath)
  await once(socket, 'connect')
  const conn: MessageConnection = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  const handlers = createHostHandlers()
  listenToHost(conn, handlers)
  conn.onClose(() => process.exit(0))
  socket.on('close', () => process.exit(0))
  conn.listen()
  await conn.sendRequest('hello', { token })

  return {
    ...windowMethods(conn, handlers),
    ...agentMethods(conn),
    ...serviceMethods(conn, handlers),
    phoneScreens: phoneScreenMethods(conn),
  }
}

export function onShutdown(fn: () => void): void {
  let ran = false
  const once = (): void => {
    if (ran) return
    ran = true
    try {
      fn()
    } catch {}
  }
  process.on('exit', once)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      once()
      process.exit(0)
    })
  }
}

export type { BrowseEntry, BrowseLimits } from '../contract/fileBrowse'
export {
  PHONE_SCREEN_REQUESTS,
  type PhoneScreenAskFor,
  type PhoneScreenAskOutcome,
  type PhoneScreenEndReason,
  type PhoneScreenEvent,
  type PhoneScreenFrameHeader,
  type PhoneScreenLink,
  type PhoneScreenReply,
  type PhoneScreenRequest,
} from '../contract/phoneScreens'

export {
  type BrowseContext,
  BrowseError,
  type BrowseFile,
  type BrowseProvider,
  type ChunkSink,
  type EntrySink,
} from './browse'
export { type CliArgs, cliArgs, expandHome, namedArgs, parseFlags } from './cliArgs'
export { AssistFailure } from './hostHandlers'
export { type MessagePageServer, startMessageServer } from './messagePage'
export { type PanelServer, startPanelServer } from './panelServer'
export type { PhoneScreenFrame, PhoneScreens, PhoneScreensController } from './phoneScreens'
export { booleanSetting, failure, numberSetting, ok } from './results'
export { nextBackoff, runTool, type ToolRun, type ToolRunOptions } from './tool'
