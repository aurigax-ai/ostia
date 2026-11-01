import { closingFromStop } from './closingLine'
import { firstQuestion, parsePayload, text } from './hookPayload'

export const CLAUDE_ATTENTION_EVENTS = [
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'PermissionDenied',
  'Stop',
  'StopFailure',
] as const

export type ClaudeAttentionEvent = (typeof CLAUDE_ATTENTION_EVENTS)[number]

export const CLAUDE_QUESTION_TOOLS = ['AskUserQuestion', 'ExitPlanMode'] as const

export function isClaudeQuestionTool(tool: unknown): boolean {
  return typeof tool === 'string' && (CLAUDE_QUESTION_TOOLS as readonly string[]).includes(tool)
}

export interface ClaudeAttention {
  state: 'waiting' | 'working' | 'done' | 'error'
  message: string
  closing?: string
  soft?: true
}

const NOT_WAITING_NOTIFICATIONS: ReadonlySet<string> = new Set(['idle_prompt', 'agent_completed'])
const IDLE_REMINDER = /waiting for your input/i
const QUESTION_TOOL_PERMISSION = new RegExp(
  `permission to use (?:${CLAUDE_QUESTION_TOOLS.join('|')})\\b`,
  'i',
)

export function isClaudeAttentionEvent(value: unknown): value is ClaudeAttentionEvent {
  return typeof value === 'string' && (CLAUDE_ATTENTION_EVENTS as readonly string[]).includes(value)
}

function notificationAttention(payload: Record<string, unknown>): ClaudeAttention | null {
  const type = text(payload.notification_type)
  const message = text(payload.message)
  if (NOT_WAITING_NOTIFICATIONS.has(type)) return null
  if (!type && IDLE_REMINDER.test(message)) return null
  if (QUESTION_TOOL_PERMISSION.test(message)) return null
  return { state: 'waiting', message, soft: true }
}

function questionAttention(payload: Record<string, unknown>): ClaudeAttention | null {
  const tool = text(payload.tool_name)
  if (tool === 'AskUserQuestion') {
    return { state: 'waiting', message: firstQuestion(payload.tool_input) || 'Has a question' }
  }
  if (tool === 'ExitPlanMode') return { state: 'waiting', message: 'Plan ready for review' }
  return null
}

function deniedAttention(payload: Record<string, unknown>): ClaudeAttention {
  const tool = text(payload.tool_name)
  const reason = text(payload.reason).split('\n')[0] ?? ''
  const subject = tool ? `Refused ${tool}` : 'Refused an action'
  return { state: 'waiting', message: reason ? `${subject}: ${reason}` : subject }
}

export function claudeAttention(event: ClaudeAttentionEvent, raw: string): ClaudeAttention | null {
  const payload = parsePayload(raw)
  switch (event) {
    case 'Notification':
      return notificationAttention(payload)
    case 'PreToolUse':
      return questionAttention(payload)
    case 'PostToolUse':
      return isClaudeQuestionTool(text(payload.tool_name))
        ? { state: 'working', message: '' }
        : null
    case 'PermissionDenied':
      return deniedAttention(payload)
    case 'Stop': {
      const closing = closingFromStop(raw)
      return { state: 'done', message: '', ...(closing ? { closing } : {}) }
    }
    case 'StopFailure':
      return { state: 'error', message: text(payload.error) || 'Turn failed' }
  }
}
