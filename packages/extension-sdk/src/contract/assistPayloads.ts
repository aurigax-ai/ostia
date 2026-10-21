import {
  ASSIST_TASKS,
  type AssistPoint,
  type AssistRequests,
  type AssistResults,
  CHAT_CONTEXT_KINDS,
  CHAT_CONTEXT_MAX,
  CHAT_CONTEXT_TEXT_MAX,
  CHAT_MESSAGE_MAX,
  CHAT_MESSAGES_MAX,
  CHAT_REPLY_MAX,
  CHAT_TOOL_CALL_ID_MAX,
  CHAT_TOOL_CALLS_MAX,
  CHAT_TOOL_DESCRIPTION_MAX,
  CHAT_TOOL_ERROR_MAX,
  CHAT_TOOL_INPUT_MAX,
  CHAT_TOOL_NAME_PATTERN,
  CHAT_TOOL_OUTPUT_MAX,
  CHAT_TOOL_SCHEMA_MAX,
  CHAT_TOOL_STATES,
  CHAT_TOOLS_MAX,
  type ChatAssistRequest,
  type ChatContextItem,
  type ChatContextKind,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolSpec,
  type ChatToolState,
  COMMAND_QUERY_MAX,
  COMMAND_SUGGESTIONS_MAX,
  COMMAND_TEXT_MAX,
  COMPLETION_NEIGHBOR_TEXT_MAX,
  COMPLETION_NEIGHBORS_MAX,
  COMPLETION_PREFIX_MAX,
  COMPLETION_SUFFIX_MAX,
  COMPLETION_TEXT_MAX,
  type CommandAssistRequest,
  type CommandAssistResult,
  type CommandSuggestion,
  type CompletionAssistRequest,
  type CompletionNeighbor,
  INPUT_TEXT_MAX,
  type InputAssistRequest,
  type InputAssistResult,
  type PromptReview,
  REVIEW_NOTE_MAX,
  REVIEW_NOTES_MAX,
  TERMINAL_COMPLETION_MAX,
  TERMINAL_CONTEXT_MAX,
  TERMINAL_CONTEXT_TEXT_MAX,
  TERMINAL_HISTORY_COMMAND_MAX,
  TERMINAL_HISTORY_MAX,
  TERMINAL_LINE_MAX,
  type TerminalAssistRequest,
  type TerminalContextEntry,
  type TerminalHistoryEntry,
} from './assist'
import { isRecord } from './isRecord'

const SHORT_MAX = 200
const PATH_MAX = 4096

function lineNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined
}

export function normalizeChatContextItem(raw: unknown): ChatContextItem | null {
  if (!isRecord(raw) || !CHAT_CONTEXT_KINDS.includes(raw.kind as ChatContextKind)) return null
  const label = optionalShort(raw.label, SHORT_MAX)
  const text = clip(raw.text, CHAT_CONTEXT_TEXT_MAX)
  if (!label || !text) return null
  const item: ChatContextItem = { kind: raw.kind as ChatContextKind, label, text }
  const path = optionalShort(raw.path, PATH_MAX)
  if (path?.startsWith('/')) {
    item.path = path
    const startLine = lineNumber(raw.startLine)
    const endLine = lineNumber(raw.endLine)
    if (startLine && endLine && endLine >= startLine) {
      item.startLine = startLine
      item.endLine = endLine
    }
  }
  return item
}

function clip(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null
}

export function optionalShort(v: unknown, max = SHORT_MAX): string | undefined {
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
    const normalized = normalizeChatContextItem(item)
    if (normalized) context.push(normalized)
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
