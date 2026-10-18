export const ASSIST_POINTS = ['input', 'command', 'completion', 'terminal', 'chat'] as const

export type AssistPoint = (typeof ASSIST_POINTS)[number]

export function isAssistPoint(v: unknown): v is AssistPoint {
  return ASSIST_POINTS.includes(v as AssistPoint)
}

export const ASSIST_LABEL_MAX = 80

export const CHAT_TOOL_MODES = ['native', 'prompted'] as const

export type ChatToolMode = (typeof CHAT_TOOL_MODES)[number]

export function isChatToolMode(v: unknown): v is ChatToolMode {
  return CHAT_TOOL_MODES.includes(v as ChatToolMode)
}

export interface AssistPointStatus {
  ready: boolean
  label?: string
  tools?: ChatToolMode
}

export type AssistStatus = Partial<Record<AssistPoint, AssistPointStatus>>

export interface AssistModelRef {
  extId: string
  provider?: string
  model?: string
}

export function sameModelRef(a: AssistModelRef | null, b: AssistModelRef | null): boolean {
  if (!a || !b) return a === b
  return a.extId === b.extId && a.provider === b.provider && a.model === b.model
}

export function modelRefKey(ref: AssistModelRef): string {
  return JSON.stringify([ref.extId, ref.provider ?? null, ref.model ?? null])
}

export interface AssistProviderInfo {
  extId: string
  name: string
  label?: string
  tools?: ChatToolMode
  ref: AssistModelRef
}

export type AssistAvailability = Partial<Record<AssistPoint, AssistProviderInfo>>

export const ASSIST_FEATURES = [
  'chat',
  'typos',
  'promptReview',
  'commandSuggest',
  'terminalCompletions',
  'editorCompletions',
  'explainError',
] as const

export type AssistFeatureId = (typeof ASSIST_FEATURES)[number]

export function featureModelClass(id: AssistFeatureId): 'chat' | 'fast' {
  return id === 'chat' || id === 'explainError' ? 'chat' : 'fast'
}

export interface AssistFeatureState {
  id: AssistFeatureId
  setting: string
  on: boolean
  ready: boolean
}

export const ASSIST_SETUP_PROBLEMS = [
  'no-provider',
  'no-endpoint',
  'no-key',
  'no-model',
  'unreachable',
] as const

export type AssistSetupProblem = (typeof ASSIST_SETUP_PROBLEMS)[number]

export const ASSIST_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
export const ASSIST_PROVIDERS_MAX = 16
export const ASSIST_PROVIDER_MODELS_MAX = 32
export const ASSIST_PROVIDER_NAME_MAX = 60
export const ASSIST_PROVIDER_URL_MAX = 2048
export const ASSIST_KINDS_MAX = 16

export const ASSIST_KEY_NEEDS = ['required', 'optional'] as const

export type AssistKeyNeed = (typeof ASSIST_KEY_NEEDS)[number]

export interface AssistProviderKind {
  id: string
  title: string
  baseUrl: string
  key: AssistKeyNeed
}

export interface AssistCatalogModel {
  id: string
  tools?: ChatToolMode
}

export interface AssistProviderState {
  id: string
  kind: string
  name: string
  setup: AssistSetupProblem | null
  lastError?: string
  lifecycle: boolean
  models: AssistCatalogModel[]
}

export interface AssistReport {
  status: AssistStatus
  features?: AssistFeatureState[]
  setup?: AssistSetupProblem | null
  lastError?: string
  label?: string
  models?: boolean
  providers?: AssistProviderState[]
  kinds?: AssistProviderKind[]
}

export interface AssistExtensionState {
  extId: string
  name: string
  label?: string
  setup: AssistSetupProblem | null
  lastError?: string
  features: AssistFeatureState[]
  models: boolean
  providers: AssistProviderState[]
  kinds: AssistProviderKind[]
  keysSet: string[]
}

export interface AssistProviderConfig {
  id: string
  extId: string
  kind: string
  name: string
  baseUrl: string
  enabled: boolean
  models: string[]
}

export interface AssistModelSettings {
  providers: AssistProviderConfig[]
  fastModel: AssistModelRef | null
  chatModel: AssistModelRef | null
}

export const DEFAULT_ASSIST_MODEL_SETTINGS: AssistModelSettings = {
  providers: [],
  fastModel: null,
  chatModel: null,
}

export interface AssistProviderEntry {
  id: string
  kind: string
  name: string
  baseUrl: string
  models: string[]
  apiKey: string | null
}

export interface AssistModelChoice {
  ref: AssistModelRef
  group: string
  label: string
  tools?: ChatToolMode
  points: AssistPoint[]
}

export interface AssistCatalog {
  models: AssistModelChoice[]
  chat: AssistModelRef | null
  fast: AssistModelRef | null
}

export const EMPTY_ASSIST_CATALOG: AssistCatalog = { models: [], chat: null, fast: null }

export type AssistModelClass = 'chat' | 'fast'

export function modelClassOf(point: AssistPoint): AssistModelClass {
  return point === 'chat' ? 'chat' : 'fast'
}

export function choiceLabel(choice: Pick<AssistModelChoice, 'group' | 'label'>): string {
  return choice.group === choice.label ? choice.label : `${choice.group} · ${choice.label}`
}

export type AssistKeyResult = { ok: true } | { ok: false; error: string }

export const ASSIST_UIS = ['chat', 'ask', 'compose'] as const

export type AssistUi = (typeof ASSIST_UIS)[number]

export interface AssistOpenUiRequest {
  extId: string
  ui: AssistUi
  workspaceId?: string
}

export const ASSIST_ERROR_MAX = 240

export const ASSIST_TASKS = ['typos', 'review'] as const

export type AssistTask = (typeof ASSIST_TASKS)[number]

export const TERMINAL_LINE_MAX = 1000
export const TERMINAL_HISTORY_MAX = 10
export const TERMINAL_HISTORY_COMMAND_MAX = 500
export const TERMINAL_CONTEXT_MAX = 6
export const TERMINAL_CONTEXT_TEXT_MAX = 200
export const TERMINAL_COMPLETION_MAX = 500
export const INPUT_TEXT_MAX = 8000
export const COMMAND_QUERY_MAX = 1000
export const COMPLETION_PREFIX_MAX = 6000
export const COMPLETION_SUFFIX_MAX = 2000
export const COMPLETION_NEIGHBORS_MAX = 3
export const COMPLETION_NEIGHBOR_TEXT_MAX = 2000
export const COMPLETION_TEXT_MAX = 2000
export const CHAT_MESSAGES_MAX = 40
export const CHAT_MESSAGE_MAX = 20_000
export const CHAT_CONTEXT_MAX = 6
export const CHAT_CONTEXT_TEXT_MAX = 20_000
export const CHAT_REPLY_MAX = 100_000
export const CHAT_STREAM_MAX = 1_000_000
export const CHAT_TOOLS_MAX = 64
export const CHAT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const CHAT_TOOL_DESCRIPTION_MAX = 8000
export const CHAT_TOOL_SCHEMA_MAX = 16_384
export const CHAT_TOOL_CALLS_MAX = 16
export const CHAT_TOOL_CALL_ID_MAX = 128
export const CHAT_TOOL_INPUT_MAX = 131_072
export const CHAT_TOOL_OUTPUT_MAX = 32_000
export const CHAT_TOOL_ERROR_MAX = 1000
export const REVIEW_NOTES_MAX = 5
export const REVIEW_NOTE_MAX = 240
export const COMMAND_SUGGESTIONS_MAX = 3
export const COMMAND_TEXT_MAX = 2000
export interface InputAssistRequest {
  text: string
  tasks: AssistTask[]
  agent?: string
}

export interface PromptReview {
  score?: number
  notes: string[]
}

export interface InputAssistResult {
  corrected?: string
  review?: PromptReview
}

export interface CommandAssistRequest {
  query: string
  cwd?: string
  shell?: string
  platform?: string
}

export interface CommandSuggestion {
  command: string
  description?: string
}

export interface CommandAssistResult {
  suggestions: CommandSuggestion[]
}

export interface TerminalHistoryEntry {
  command: string
  exitCode?: number
}

export interface TerminalContextEntry {
  label: string
  text: string
}

export interface TerminalAssistRequest {
  line: string
  cwd?: string
  shell?: string
  platform?: string
  history?: TerminalHistoryEntry[]
  context?: TerminalContextEntry[]
}

export interface TerminalAssistResult {
  text: string
}

export interface CompletionNeighbor {
  path: string
  text: string
}

export interface CompletionAssistRequest {
  path: string
  language: string
  prefix: string
  suffix: string
  neighbors?: CompletionNeighbor[]
}

export interface CompletionAssistResult {
  text: string
}

export type ChatRole = 'user' | 'assistant'

export const CHAT_TOOL_STATES = ['done', 'error', 'denied'] as const

export type ChatToolState = (typeof CHAT_TOOL_STATES)[number]

export interface ChatToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  state: ChatToolState
  output?: string
  error?: string
}

export interface ChatMessage {
  role: ChatRole
  content: string
  tools?: ChatToolCall[]
}

export interface ChatToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const CHAT_CONTEXT_KINDS = [
  'output',
  'selection',
  'cwd',
  'pane',
  'error',
  'file',
  'editor',
  'browser',
] as const

export type ChatContextKind = (typeof CHAT_CONTEXT_KINDS)[number]

export interface ChatContextItem {
  kind: ChatContextKind
  label: string
  text: string
  path?: string
  startLine?: number
  endLine?: number
}

export interface ChatAssistRequest {
  messages: ChatMessage[]
  context: ChatContextItem[]
  tools?: ChatToolSpec[]
}

export interface ChatAssistResult {
  text: string
}

export interface AssistRequests {
  input: InputAssistRequest
  command: CommandAssistRequest
  completion: CompletionAssistRequest
  terminal: TerminalAssistRequest
  chat: ChatAssistRequest
}

export interface AssistResults {
  input: InputAssistResult
  command: CommandAssistResult
  completion: CompletionAssistResult
  terminal: TerminalAssistResult
  chat: ChatAssistResult
}

export const ASSIST_ERRORS = [
  'unavailable',
  'cancelled',
  'invalid',
  'failed',
  'rate-limited',
  'busy',
] as const

export type AssistError = (typeof ASSIST_ERRORS)[number]

export type AssistResponse<P extends AssistPoint> = (
  | { ok: true; result: AssistResults[P] }
  | { ok: false; error: AssistError; message?: string }
) & { chunks?: number }

export interface AssistChunk {
  requestId: string
  text: string
}

export const ASSIST_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export interface AssistApi {
  availability: () => Promise<AssistAvailability>
  onAvailability: (cb: (availability: AssistAvailability) => void) => () => void
  request: <P extends AssistPoint>(
    point: P,
    requestId: string,
    input: AssistRequests[P],
    model?: AssistModelRef,
  ) => Promise<AssistResponse<P>>
  cancel: (requestId: string) => void
  onChunk: (cb: (chunk: AssistChunk) => void) => () => void
  overview: () => Promise<AssistExtensionState[]>
  onOverview: (cb: (overview: AssistExtensionState[]) => void) => () => void
  onOpenUi: (cb: (req: AssistOpenUiRequest) => void) => () => void
  reportShortcuts: (shortcuts: Record<string, string>) => void
  models: (extId: string, provider?: string) => Promise<AssistModelsResult>
  setModelLoaded: (
    extId: string,
    id: string,
    loaded: boolean,
    provider?: string,
  ) => Promise<AssistModelChangeResult>
  catalog: () => Promise<AssistCatalog>
  onCatalog: (cb: (catalog: AssistCatalog) => void) => () => void
  setProviderKey: (providerId: string, value: string | null) => Promise<AssistKeyResult>
}

export const ASSIST_MODELS_MAX = 64
export const ASSIST_MODEL_ID_MAX = 200
export const ASSIST_MODEL_DESCRIPTION_MAX = 400

export interface AssistModel {
  id: string
  name?: string
  description?: string
  installed?: boolean
  loaded?: boolean
  busy?: boolean
  idleSecs?: number
}

export interface AssistModelList {
  lifecycle: boolean
  models: AssistModel[]
  error?: string
}

export type AssistModelsResult = ({ ok: true } & AssistModelList) | { ok: false; error: string }

export type AssistModelChangeResult = { ok: true } | { ok: false; error: string }
