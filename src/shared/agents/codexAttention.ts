import { firstQuestion, parsePayload, text } from './hookPayload'

export const CODEX_ATTENTION_EVENTS = ['PreToolUse', 'PostToolUse'] as const

export type CodexAttentionEvent = (typeof CODEX_ATTENTION_EVENTS)[number]

export const CODEX_QUESTION_TOOL = 'request_user_input'

export interface CodexAttention {
  state: 'waiting' | 'working'
  message: string
}

export function isCodexAttentionEvent(value: unknown): value is CodexAttentionEvent {
  return typeof value === 'string' && (CODEX_ATTENTION_EVENTS as readonly string[]).includes(value)
}

export function codexAttention(event: CodexAttentionEvent, raw: string): CodexAttention | null {
  const payload = parsePayload(raw)
  if (text(payload.tool_name) !== CODEX_QUESTION_TOOL) return null
  return event === 'PreToolUse'
    ? { state: 'waiting', message: firstQuestion(payload.tool_input) || 'Has a question' }
    : { state: 'working', message: '' }
}
