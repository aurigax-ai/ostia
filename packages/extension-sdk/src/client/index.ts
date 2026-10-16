import { once } from 'node:events'
import { createConnection } from 'node:net'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
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
import { EXTENSION_API_ENV, EXTENSION_API_VERSION, apiProblem } from '../contract/extensionApi'
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
  OpenTerminalOptions,
  PaneChipItem,
  RunAgentOptions,
  SandboxDomainsResult,
  SidebarKind,
  SidebarTone,
  TerminalWait,
} from '../contract/extensions'
import type {
  RemoteFilesRequest,
  RemoteListResult,
  RemoteReadResult,
  RemoteStatResult,
  RemoteWriteResult,
} from '../contract/remoteFolders'
import { agentMethods, serviceMethods, windowMethods } from './extensionMethods'
import { createHostHandlers, listenToHost } from './hostHandlers'
import type {
  AskOptions,
  AskResult,
  BusSendResult,
  ConnectionResult,
  ConnectionsResult,
  ExecOptions,
  ExecResult,
  McpCallReply,
  McpServersResult,
  WakePaneResult,
} from './workApi'

export type {
  AskOptions,
  AskResult,
  BusSendResult,
  ConnectionResult,
  ConnectionsResult,
  ExecOptions,
  ExecResult,
  McpCallReply,
  McpServerInfo,
  McpServersResult,
  WakePaneOutcome,
  WakePaneResult,
} from './workApi'
export { type AgentStop, parseAgentStop } from '../contract/agentStop'

export type {
  AgentOfferOptions,
  AgentOfferResult,
  ConnectionInfo,
  ConnectionValue,
  DiffContent,
  ExtensionCaller,
  ExtensionEventType,
  ExtensionIcon,
  ExtensionResult,
  ExtensionSettingValues,
  OpenTerminalOptions,
  PaneChipItem,
  RunAgentOptions,
  SandboxDomainsResult,
  SidebarTone,
  TerminalWait,
  TerminalWaitOutcome,
} from '../contract/extensions'

export {
  EXTENSION_REDACT_TEXTS_MAX,
  EXTENSION_REDACT_TEXT_MAX,
  OPEN_TERMINAL_WAIT_MAX_MS,
} from '../contract/extensions'

export {
  type MessageVars,
  type Translate,
  formatMessage,
  localized,
  matchLocale,
} from '../contract/extensionLocales'
export { createTranslator } from './i18n'

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
  notify: (title: string, body?: string) => Promise<unknown>
  openPanel: (workspaceId?: string, path?: string) => Promise<unknown>
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
  ask: (opts: AskOptions, signal?: AbortSignal) => Promise<AskResult>
  mcpCall: (
    server: string,
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<McpCallReply>
  mcpServers: () => Promise<McpServersResult>
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
  sandboxDomains: (workspaceId: string) => Promise<SandboxDomainsResult>
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
  const incompatible = provided ? apiProblem(EXTENSION_API_VERSION, provided) : null
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

export { nextBackoff, runTool, type ToolRun, type ToolRunOptions } from './tool'
export { type MessagePageServer, startMessageServer } from './messagePage'

export { ok, failure, numberSetting, booleanSetting } from './results'
export { AssistFailure } from './hostHandlers'
export { type CliArgs, cliArgs, namedArgs, parseFlags, expandHome } from './cliArgs'
export { type PanelServer, startPanelServer } from './panelServer'
