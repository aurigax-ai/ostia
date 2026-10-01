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

export interface AssistProviderInfo {
  extId: string
  name: string
  label?: string
  tools?: ChatToolMode
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

export interface AssistReport {
  status: AssistStatus
  features?: AssistFeatureState[]
  setup?: AssistSetupProblem | null
  lastError?: string
  label?: string
  models?: boolean
}

export interface AssistExtensionState {
  extId: string
  name: string
  label?: string
  setup: AssistSetupProblem | null
  lastError?: string
  features: AssistFeatureState[]
  models: boolean
}

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
const SHORT_MAX = 200
const PATH_MAX = 4096

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
  'browser',
] as const

export type ChatContextKind = (typeof CHAT_CONTEXT_KINDS)[number]

export interface ChatContextItem {
  kind: ChatContextKind
  label: string
  text: string
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
  ) => Promise<AssistResponse<P>>
  cancel: (requestId: string) => void
  onChunk: (cb: (chunk: AssistChunk) => void) => () => void
  overview: () => Promise<AssistExtensionState[]>
  onOverview: (cb: (overview: AssistExtensionState[]) => void) => () => void
  onOpenUi: (cb: (req: AssistOpenUiRequest) => void) => () => void
  reportShortcuts: (shortcuts: Record<string, string>) => void
  models: (extId: string) => Promise<AssistModelsResult>
  setModelLoaded: (extId: string, id: string, loaded: boolean) => Promise<AssistModelChangeResult>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function clip(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null
}

function optionalShort(v: unknown, max = SHORT_MAX): string | undefined {
  if (typeof v !== 'string') return undefined
  const text = v.trim().slice(0, max)
  return text || undefined
}

function withOptional<T extends object>(base: T, extra: Record<string, unknown>): T {
  const out = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) out[key] = value
  return out as T
}

function inputRequest(raw: Record<string, unknown>): InputAssistRequest | null {
  const text = clip(raw.text, INPUT_TEXT_MAX)
  if (!text?.trim()) return null
  const tasks = Array.isArray(raw.tasks)
    ? ASSIST_TASKS.filter((task) => (raw.tasks as unknown[]).includes(task))
    : []
  if (tasks.length === 0) return null
  return withOptional({ text, tasks }, { agent: optionalShort(raw.agent, 40) })
}

function commandRequest(raw: Record<string, unknown>): CommandAssistRequest | null {
  const query = clip(raw.query, COMMAND_QUERY_MAX)?.trim()
  if (!query) return null
  return withOptional(
    { query },
    {
      cwd: optionalShort(raw.cwd, PATH_MAX),
      shell: optionalShort(raw.shell, 40),
      platform: optionalShort(raw.platform, 40),
    },
  )
}

function neighbors(raw: unknown): CompletionNeighbor[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: CompletionNeighbor[] = []
  for (const item of raw.slice(0, COMPLETION_NEIGHBORS_MAX)) {
    if (!isRecord(item)) continue
    const path = optionalShort(item.path, PATH_MAX)
    const text = clip(item.text, COMPLETION_NEIGHBOR_TEXT_MAX)
    if (path && text) out.push({ path, text })
  }
  return out.length > 0 ? out : undefined
}

function completionRequest(raw: Record<string, unknown>): CompletionAssistRequest | null {
  const path = optionalShort(raw.path, PATH_MAX)
  const language = optionalShort(raw.language, 40)
  const prefix = typeof raw.prefix === 'string' ? raw.prefix.slice(-COMPLETION_PREFIX_MAX) : null
  const suffix = clip(raw.suffix, COMPLETION_SUFFIX_MAX)
  if (!path || !language || prefix === null || suffix === null) return null
  return withOptional({ path, language, prefix, suffix }, { neighbors: neighbors(raw.neighbors) })
}

function terminalRequest(raw: Record<string, unknown>): TerminalAssistRequest | null {
  const line = clip(raw.line, TERMINAL_LINE_MAX)
  if (!line?.trim()) return null
  const history: TerminalHistoryEntry[] = []
  for (const item of Array.isArray(raw.history) ? raw.history.slice(-TERMINAL_HISTORY_MAX) : []) {
    if (!isRecord(item)) continue
    const command = optionalShort(item.command, TERMINAL_HISTORY_COMMAND_MAX)
    if (!command) continue
    const code = item.exitCode
    history.push(
      typeof code === 'number' && Number.isInteger(code)
        ? { command, exitCode: code }
        : { command },
    )
  }
  const context: TerminalContextEntry[] = []
  for (const item of Array.isArray(raw.context) ? raw.context.slice(0, TERMINAL_CONTEXT_MAX) : []) {
    if (!isRecord(item)) continue
    const label = optionalShort(item.label, 80)
    const text = optionalShort(item.text, TERMINAL_CONTEXT_TEXT_MAX)
    if (label && text) context.push({ label, text })
  }
  return withOptional(
    { line },
    {
      cwd: optionalShort(raw.cwd, PATH_MAX),
      shell: optionalShort(raw.shell, 40),
      platform: optionalShort(raw.platform, 40),
      history: history.length > 0 ? history : undefined,
      context: context.length > 0 ? context : undefined,
    },
  )
}

function jsonObject(v: unknown, max: number): Record<string, unknown> | null {
  if (!isRecord(v)) return null
  try {
    const json = JSON.stringify(v)
    return json.length <= max ? (JSON.parse(json) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function toolCall(raw: unknown): ChatToolCall | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.slice(0, CHAT_TOOL_CALL_ID_MAX) : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!id || !CHAT_TOOL_NAME_PATTERN.test(name)) return null
  if (!CHAT_TOOL_STATES.includes(raw.state as ChatToolState)) return null
  const input = jsonObject(raw.input ?? {}, CHAT_TOOL_INPUT_MAX) ?? {}
  const state = raw.state as ChatToolState
  const call: ChatToolCall = { id, name, input, state }
  if (state === 'done') call.output = clip(raw.output, CHAT_TOOL_OUTPUT_MAX) ?? ''
  if (state === 'error') call.error = clip(raw.error, CHAT_TOOL_ERROR_MAX) || 'failed'
  return call
}

function chatMessage(item: unknown): ChatMessage | null {
  if (!isRecord(item) || (item.role !== 'user' && item.role !== 'assistant')) return null
  const content = clip(item.content, CHAT_MESSAGE_MAX)
  if (content === null) return null
  if (item.role === 'user' || !Array.isArray(item.tools) || item.tools.length === 0) {
    return { role: item.role, content }
  }
  const tools = item.tools
    .slice(0, CHAT_TOOL_CALLS_MAX)
    .map(toolCall)
    .filter((t): t is ChatToolCall => t !== null)
  return tools.length > 0 ? { role: 'assistant', content, tools } : { role: 'assistant', content }
}

function toolSpecs(raw: unknown): ChatToolSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ChatToolSpec[] = []
  for (const item of raw) {
    if (out.length === CHAT_TOOLS_MAX) break
    if (!isRecord(item) || typeof item.name !== 'string') continue
    if (!CHAT_TOOL_NAME_PATTERN.test(item.name) || out.some((t) => t.name === item.name)) continue
    const description = clip(item.description, CHAT_TOOL_DESCRIPTION_MAX)?.trim()
    const inputSchema = jsonObject(item.inputSchema, CHAT_TOOL_SCHEMA_MAX)
    if (!description || !inputSchema || inputSchema.type !== 'object') continue
    out.push({ name: item.name, description, inputSchema })
  }
  return out.length > 0 ? out : undefined
}

function endsTurn(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1]
  return last !== undefined && (last.role === 'user' || (last.tools?.length ?? 0) > 0)
}

function chatRequest(raw: Record<string, unknown>): ChatAssistRequest | null {
  if (!Array.isArray(raw.messages)) return null
  const messages: ChatMessage[] = []
  for (const item of raw.messages.slice(-CHAT_MESSAGES_MAX)) {
    const message = chatMessage(item)
    if (!message) return null
    messages.push(message)
  }
  while (messages.length > 0 && messages[0].role !== 'user') messages.shift()
  if (!endsTurn(messages)) return null
  const context: ChatContextItem[] = []
  for (const item of Array.isArray(raw.context) ? raw.context.slice(0, CHAT_CONTEXT_MAX) : []) {
    if (!isRecord(item) || !CHAT_CONTEXT_KINDS.includes(item.kind as ChatContextKind)) continue
    const label = optionalShort(item.label, SHORT_MAX)
    const text = clip(item.text, CHAT_CONTEXT_TEXT_MAX)
    if (label && text) context.push({ kind: item.kind as ChatContextKind, label, text })
  }
  const tools = toolSpecs(raw.tools)
  return tools ? { messages, context, tools } : { messages, context }
}

export function normalizeAssistRequest<P extends AssistPoint>(
  point: P,
  raw: unknown,
): AssistRequests[P] | null {
  if (!isRecord(raw)) return null
  const parsers: { [K in AssistPoint]: (r: Record<string, unknown>) => AssistRequests[K] | null } =
    {
      input: inputRequest,
      command: commandRequest,
      completion: completionRequest,
      terminal: terminalRequest,
      chat: chatRequest,
    }
  return parsers[point](raw) as AssistRequests[P] | null
}

function inputResult(raw: Record<string, unknown>): InputAssistResult {
  const out: InputAssistResult = {}
  const corrected = clip(raw.corrected, INPUT_TEXT_MAX)
  if (corrected?.trim()) out.corrected = corrected
  if (isRecord(raw.review)) {
    const notes = Array.isArray(raw.review.notes)
      ? raw.review.notes
          .map((n) => optionalShort(n, REVIEW_NOTE_MAX))
          .filter((n): n is string => n !== undefined)
          .slice(0, REVIEW_NOTES_MAX)
      : []
    const score = raw.review.score
    const review: PromptReview = { notes }
    if (typeof score === 'number' && Number.isFinite(score)) {
      review.score = Math.min(5, Math.max(1, Math.round(score)))
    }
    out.review = review
  }
  return out
}

function commandResult(raw: Record<string, unknown>): CommandAssistResult {
  const suggestions: CommandSuggestion[] = []
  for (const item of Array.isArray(raw.suggestions) ? raw.suggestions : []) {
    if (!isRecord(item)) continue
    const command = clip(item.command, COMMAND_TEXT_MAX)?.trim()
    if (!command || suggestions.some((s) => s.command === command)) continue
    suggestions.push(
      withOptional({ command }, { description: optionalShort(item.description, SHORT_MAX) }),
    )
    if (suggestions.length === COMMAND_SUGGESTIONS_MAX) break
  }
  return { suggestions }
}

function textResult(raw: Record<string, unknown>, max: number): { text: string } {
  return { text: clip(raw.text, max) ?? '' }
}

export function normalizeAssistResult<P extends AssistPoint>(
  point: P,
  raw: unknown,
): AssistResults[P] {
  const r = isRecord(raw) ? raw : {}
  const parsers: { [K in AssistPoint]: (r: Record<string, unknown>) => AssistResults[K] } = {
    input: inputResult,
    command: commandResult,
    completion: (x) => textResult(x, COMPLETION_TEXT_MAX),
    terminal: (x) => ({ text: (clip(x.text, TERMINAL_COMPLETION_MAX) ?? '').split('\n')[0] }),
    chat: (x) => textResult(x, CHAT_REPLY_MAX),
  }
  return parsers[point](r) as AssistResults[P]
}

export function normalizeAssistStatus(raw: unknown): AssistStatus {
  const out: AssistStatus = {}
  if (!isRecord(raw)) return out
  for (const point of ASSIST_POINTS) {
    const entry = raw[point]
    if (!isRecord(entry)) continue
    const status: AssistPointStatus = { ready: entry.ready === true }
    const label = optionalShort(entry.label, ASSIST_LABEL_MAX)
    if (label) status.label = label
    if (point === 'chat' && isChatToolMode(entry.tools)) status.tools = entry.tools
    out[point] = status
  }
  return out
}

export function normalizeAssistFeatures(
  raw: unknown,
): { id: AssistFeatureId; setting: string; ready: boolean }[] {
  const out: { id: AssistFeatureId; setting: string; ready: boolean }[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item) || !ASSIST_FEATURES.includes(item.id as AssistFeatureId)) continue
    if (typeof item.setting !== 'string' || out.some((f) => f.id === item.id)) continue
    out.push({ id: item.id as AssistFeatureId, setting: item.setting, ready: item.ready === true })
  }
  return out
}

export function normalizeSetupProblem(raw: unknown): AssistSetupProblem | null {
  return ASSIST_SETUP_PROBLEMS.includes(raw as AssistSetupProblem)
    ? (raw as AssistSetupProblem)
    : null
}

export function normalizeAssistError(raw: unknown): string | undefined {
  return optionalShort(raw, ASSIST_ERROR_MAX)
}

export function normalizeAssistLabel(raw: unknown): string | undefined {
  return optionalShort(raw, ASSIST_LABEL_MAX)
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

export function isAssistModelId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= ASSIST_MODEL_ID_MAX
}

function assistModel(raw: unknown): AssistModel | null {
  if (!isRecord(raw) || !isAssistModelId(raw.id)) return null
  const model: AssistModel = { id: raw.id }
  const name = optionalShort(raw.name)
  if (name) model.name = name
  const description = optionalShort(raw.description, ASSIST_MODEL_DESCRIPTION_MAX)
  if (description) model.description = description
  if (typeof raw.installed === 'boolean') model.installed = raw.installed
  if (typeof raw.loaded === 'boolean') model.loaded = raw.loaded
  if (typeof raw.busy === 'boolean') model.busy = raw.busy
  if (typeof raw.idleSecs === 'number' && Number.isFinite(raw.idleSecs) && raw.idleSecs >= 0) {
    model.idleSecs = Math.floor(raw.idleSecs)
  }
  return model
}

export function normalizeAssistModels(raw: unknown): AssistModelList | null {
  if (!isRecord(raw)) return null
  const models: AssistModel[] = []
  for (const item of Array.isArray(raw.models) ? raw.models : []) {
    const model = assistModel(item)
    if (model && !models.some((m) => m.id === model.id)) models.push(model)
    if (models.length === ASSIST_MODELS_MAX) break
  }
  const list: AssistModelList = { lifecycle: raw.lifecycle === true, models }
  const error = normalizeAssistError(raw.error)
  if (error) list.error = error
  return list
}
