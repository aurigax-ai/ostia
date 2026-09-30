import { CHAT_CONTEXT_KINDS, type ChatContextItem, type ChatContextKind } from './assist'

export interface ChatPart {
  type: string
  text?: string
  [key: string]: unknown
}

export type ChatSessionRole = 'system' | 'user' | 'assistant'

export interface ChatMessageMetadata {
  createdAt?: number
  context?: ChatContextItem[]
  model?: string
  error?: string
  stopped?: boolean
}

export interface ChatSessionMessage {
  id: string
  role: ChatSessionRole
  parts: ChatPart[]
  metadata?: ChatMessageMetadata
}

export interface ChatSessionSummary {
  id: string
  workspaceId?: string
  title: string
  createdAt: number
  updatedAt: number
  model?: string
  messageCount: number
  trimmed?: boolean
}

export interface ChatSession extends ChatSessionSummary {
  messages: ChatSessionMessage[]
}

export type ChatSaveResult =
  | { ok: true; summary: ChatSessionSummary; trimmedMessages: number; evicted: string[] }
  | { ok: false; error: string }

export type ChatExportResult = { ok: true; path: string } | { ok: false; error: string }

export interface ChatSessionsApi {
  list: () => Promise<ChatSessionSummary[]>
  get: (id: string) => Promise<ChatSession | null>
  save: (session: ChatSession) => Promise<ChatSaveResult>
  rename: (id: string, title: string) => Promise<ChatSessionSummary | null>
  remove: (id: string) => Promise<boolean>
  exportMarkdown: (id: string) => Promise<ChatExportResult>
  saveFile: (suggestedName: string, content: string) => Promise<ChatExportResult>
}

export const CHAT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const CHAT_TITLE_MAX = 120
export const CHAT_SESSION_MAX_BYTES = 512 * 1024
export const CHAT_TOTAL_MAX_BYTES = 16 * 1024 * 1024
export const CHAT_SESSIONS_MAX = 500
export const CHAT_SESSION_MESSAGES_MAX = 400
const TEXT_MAX = 100_000
const PART_JSON_MAX = 64 * 1024
const PART_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const CONTEXT_TEXT_MAX = 20_000
const SHORT_MAX = 200

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function short(v: unknown, max = SHORT_MAX): string | undefined {
  if (typeof v !== 'string') return undefined
  const text = v.trim().slice(0, max)
  return text || undefined
}

export function chatTitle(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  return text.slice(0, CHAT_TITLE_MAX)
}

function part(raw: unknown): ChatPart | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !PART_TYPE_PATTERN.test(raw.type)) {
    return null
  }
  if (raw.type === 'text' || raw.type === 'reasoning') {
    return typeof raw.text === 'string'
      ? { type: raw.type, text: raw.text.slice(0, TEXT_MAX) }
      : null
  }
  try {
    const json = JSON.stringify(raw)
    if (json.length <= PART_JSON_MAX) return JSON.parse(json) as ChatPart
    if (!isToolPartType(raw.type)) return null
    for (const max of CLIP_STEPS) {
      const clipped = JSON.stringify(clipStrings(raw, max))
      if (clipped.length <= PART_JSON_MAX) return JSON.parse(clipped) as ChatPart
    }
    return null
  } catch {
    return null
  }
}

const CLIP_STEPS = [16_000, 4000, 1000, 200]
const CLIP_MARK = '…[truncated]'

export function isToolPartType(type: string): boolean {
  return type === 'dynamic-tool' || type.startsWith('tool-')
}

function clipStrings(value: unknown, max: number, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > max ? `${value.slice(0, max)}${CLIP_MARK}` : value
  }
  if (depth > 8) return null
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, max, depth + 1))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = clipStrings(v, max, depth + 1)
    return out
  }
  return value
}

function context(raw: unknown): ChatContextItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ChatContextItem[] = []
  for (const item of raw) {
    if (!isRecord(item) || !CHAT_CONTEXT_KINDS.includes(item.kind as ChatContextKind)) continue
    const label = short(item.label)
    if (!label || typeof item.text !== 'string') continue
    out.push({
      kind: item.kind as ChatContextKind,
      label,
      text: item.text.slice(0, CONTEXT_TEXT_MAX),
    })
  }
  return out.length > 0 ? out : undefined
}

function metadata(raw: unknown): ChatMessageMetadata | undefined {
  if (!isRecord(raw)) return undefined
  const out: ChatMessageMetadata = {}
  const createdAt = finite(raw.createdAt)
  if (createdAt !== null) out.createdAt = createdAt
  const ctx = context(raw.context)
  if (ctx) out.context = ctx
  const model = short(raw.model)
  if (model) out.model = model
  const error = short(raw.error, 500)
  if (error) out.error = error
  if (raw.stopped === true) out.stopped = true
  return Object.keys(out).length > 0 ? out : undefined
}

const ROLES: ReadonlySet<unknown> = new Set(['system', 'user', 'assistant'])

function message(raw: unknown): ChatSessionMessage | null {
  if (!isRecord(raw) || !ROLES.has(raw.role)) return null
  const id = typeof raw.id === 'string' && raw.id.length <= 128 ? raw.id : null
  if (!id || !Array.isArray(raw.parts)) return null
  const parts = raw.parts.map(part).filter((p): p is ChatPart => p !== null)
  const out: ChatSessionMessage = { id, role: raw.role as ChatSessionRole, parts }
  const meta = metadata(raw.metadata)
  if (meta) out.metadata = meta
  return out
}

export function normalizeChatSession(raw: unknown): ChatSession | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' && CHAT_SESSION_ID_PATTERN.test(raw.id) ? raw.id : null
  const createdAt = finite(raw.createdAt)
  const updatedAt = finite(raw.updatedAt)
  if (!id || createdAt === null || updatedAt === null || !Array.isArray(raw.messages)) return null
  const messages = raw.messages
    .map(message)
    .filter((m): m is ChatSessionMessage => m !== null)
    .slice(-CHAT_SESSION_MESSAGES_MAX)
  const session: ChatSession = {
    id,
    title: chatTitle(raw.title) || 'Chat',
    createdAt,
    updatedAt,
    messageCount: messages.length,
    messages,
  }
  const workspaceId = short(raw.workspaceId, 64)
  if (workspaceId) session.workspaceId = workspaceId
  const model = short(raw.model)
  if (model) session.model = model
  if (raw.trimmed === true) session.trimmed = true
  return session
}

export function chatSummary(session: ChatSession): ChatSessionSummary {
  const { messages: _messages, ...summary } = session
  return { ...summary, messageCount: session.messages.length }
}

export function messageText(msg: ChatSessionMessage): string {
  return msg.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}

const MARKDOWN_TOOL_MAX = 4000

const TOOL_STATE_LABELS: Record<string, string> = {
  'output-available': 'done',
  'output-error': 'failed',
  'output-denied': 'denied',
}

function fence(text: string, lang = ''): string[] {
  const ticks = text.includes('```') ? '````' : '```'
  return [`${ticks}${lang}`, text, ticks]
}

function clipped(text: string): string {
  return text.length > MARKDOWN_TOOL_MAX ? `${text.slice(0, MARKDOWN_TOOL_MAX)}${CLIP_MARK}` : text
}

function toolMarkdown(p: ChatPart): string[] {
  const name =
    p.type === 'dynamic-tool' ? String(p.toolName ?? 'tool') : p.type.slice('tool-'.length)
  const state = typeof p.state === 'string' ? p.state : ''
  const lines = [`> Tool \`${name}\`: ${TOOL_STATE_LABELS[state] ?? 'not run'}`, '']
  if (p.input !== undefined && JSON.stringify(p.input) !== '{}') {
    lines.push(...fence(clipped(JSON.stringify(p.input, null, 2)), 'json'), '')
  }
  if (state === 'output-available') {
    const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output, null, 2)
    lines.push(...fence(clipped(out ?? '')), '')
  }
  if (state === 'output-error' && typeof p.errorText === 'string') {
    lines.push(...fence(clipped(p.errorText)), '')
  }
  return lines
}

export function chatMarkdown(session: ChatSession): string {
  const lines = [`# ${session.title}`, '']
  if (session.model) lines.push(`Model: ${session.model}`, '')
  for (const msg of session.messages) {
    if (msg.role === 'system') continue
    lines.push(msg.role === 'user' ? '## You' : '## Assistant', '')
    for (const item of msg.metadata?.context ?? []) {
      lines.push(`> ${item.label}`, '', '```', item.text, '```', '')
    }
    let text = ''
    const flush = (): void => {
      if (text.trim()) lines.push(text, '')
      text = ''
    }
    for (const p of msg.parts) {
      if (p.type === 'text' && typeof p.text === 'string') text += p.text
      else if (isToolPartType(p.type)) {
        flush()
        lines.push(...toolMarkdown(p))
      }
    }
    flush()
  }
  return `${lines.join('\n').trimEnd()}\n`
}
