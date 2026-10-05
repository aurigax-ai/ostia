export const CLAUDE_ATTENTION_EVENTS = [
  'Notification',
  'PreToolUse',
  'Stop',
  'StopFailure',
] as const

export type ClaudeAttentionEvent = (typeof CLAUDE_ATTENTION_EVENTS)[number]

export const CLAUDE_QUESTION_TOOLS = ['AskUserQuestion', 'ExitPlanMode'] as const

export interface ClaudeAttention {
  state: 'waiting' | 'done' | 'error'
  message: string
}

const NOT_WAITING_NOTIFICATIONS: ReadonlySet<string> = new Set(['idle_prompt', 'agent_completed'])
const IDLE_REMINDER = /waiting for your input/i
const MESSAGE_MAX = 300

export function isClaudeAttentionEvent(value: unknown): value is ClaudeAttentionEvent {
  return typeof value === 'string' && (CLAUDE_ATTENTION_EVENTS as readonly string[]).includes(value)
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MESSAGE_MAX) : ''
}

function firstQuestion(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const questions = (input as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return ''
  const first: unknown = questions[0]
  return typeof first === 'object' && first !== null
    ? text((first as { question?: unknown }).question)
    : ''
}

function notificationAttention(payload: Record<string, unknown>): ClaudeAttention | null {
  const type = text(payload.notification_type)
  const message = text(payload.message)
  if (NOT_WAITING_NOTIFICATIONS.has(type)) return null
  if (!type && IDLE_REMINDER.test(message)) return null
  return { state: 'waiting', message }
}

function questionAttention(payload: Record<string, unknown>): ClaudeAttention | null {
  const tool = text(payload.tool_name)
  if (tool === 'AskUserQuestion') {
    return { state: 'waiting', message: firstQuestion(payload.tool_input) || 'Has a question' }
  }
  if (tool === 'ExitPlanMode') return { state: 'waiting', message: 'Plan ready for review' }
  return null
}

export function claudeAttention(event: ClaudeAttentionEvent, raw: string): ClaudeAttention | null {
  const payload = parsePayload(raw)
  switch (event) {
    case 'Notification':
      return notificationAttention(payload)
    case 'PreToolUse':
      return questionAttention(payload)
    case 'Stop':
      return { state: 'done', message: '' }
    case 'StopFailure':
      return { state: 'error', message: text(payload.error) || 'Turn failed' }
  }
}
