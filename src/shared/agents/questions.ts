import type { PermissionInfo } from './agentPermissions'

export const QUESTION_MAX = 500
export const QUESTION_CONTEXT_MAX = 4000
export const QUESTION_CHOICES_MAX = 12
export const QUESTION_CHOICE_MAX = 120
export const QUESTION_REPLY_MAX = 4000
export const QUESTIONS_PER_PANE = 3
export const QUESTION_RATE_LIMIT = 6
export const QUESTION_RATE_WINDOW_MS = 60_000
export const QUESTION_TIMEOUT_MIN_S = 1
export const QUESTION_TIMEOUT_MAX_S = 86_400

export const QUESTION_MODES = ['text', 'single', 'multi'] as const
export type QuestionMode = (typeof QUESTION_MODES)[number]

export interface QuestionRequest {
  id: string
  paneId: string
  question: string
  context: string
  choices: string[]
  mode: QuestionMode
  at: number
  expiresAt?: number
  permission?: PermissionInfo
}

export interface QuestionState {
  pending: QuestionRequest[]
}

export interface QuestionReply {
  choices: number[]
  text: string
}

export type QuestionEnd = 'dismissed' | 'timeout' | 'closed'

export type QuestionOutcome =
  | { outcome: 'answered'; choices: string[]; text: string }
  | { outcome: QuestionEnd }

export type QuestionAskError =
  | 'invalid-question'
  | 'invalid-context'
  | 'invalid-choices'
  | 'invalid-timeout'
  | 'too-many-questions'
  | 'rate-limited'

export type QuestionAskResult =
  | ({ ok: true } & QuestionOutcome)
  | { ok: false; error: QuestionAskError; message: string }

export interface QuestionContent {
  question: string
  context: string
  choices: string[]
  mode: QuestionMode
  timeoutMs?: number
}

export type QuestionContentResult =
  | { ok: true; content: QuestionContent }
  | { ok: false; error: QuestionAskError; message: string }

const TAB = 9
const LF = 10
const DEL = 127

function isControl(code: number): boolean {
  return code < 32 || code === DEL || (code >= 0x80 && code <= 0x9f)
}

function withoutControls(text: string, keepLayout: boolean): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (!isControl(code)) out += text[i]
    else if (code === LF || code === TAB) out += keepLayout ? text[i] : ' '
  }
  return out
}

export function clipTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function oneLine(raw: string): string {
  return withoutControls(raw, false).replace(/\s+/g, ' ').trim()
}

export function plainBlock(raw: string): string {
  return withoutControls(raw.replace(/\r\n?/g, '\n'), true).trim()
}

function refuse(error: QuestionAskError, message: string): QuestionContentResult {
  return { ok: false, error, message }
}

export function normalizeQuestion(raw: unknown): QuestionContentResult {
  const params = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (typeof params.question !== 'string') return refuse('invalid-question', 'a question is needed')
  const question = oneLine(params.question)
  if (!question) return refuse('invalid-question', 'a question is needed')
  if (params.context !== undefined && typeof params.context !== 'string') {
    return refuse('invalid-context', 'context must be text')
  }
  const context = plainBlock(params.context ?? '')
  const rawChoices = params.choices ?? []
  if (!Array.isArray(rawChoices) || rawChoices.some((c) => typeof c !== 'string')) {
    return refuse('invalid-choices', 'choices must be a list of labels')
  }
  if (rawChoices.length > QUESTION_CHOICES_MAX) {
    return refuse('invalid-choices', `at most ${QUESTION_CHOICES_MAX} choices`)
  }
  const choices = (rawChoices as string[]).map(oneLine)
  if (choices.some((c) => !c)) return refuse('invalid-choices', 'a choice is empty')
  if (choices.some((c) => c.length > QUESTION_CHOICE_MAX)) {
    return refuse('invalid-choices', `a choice is longer than ${QUESTION_CHOICE_MAX} characters`)
  }
  if (new Set(choices).size !== choices.length) {
    return refuse('invalid-choices', 'two choices have the same label')
  }
  if (params.multi !== undefined && typeof params.multi !== 'boolean') {
    return refuse('invalid-choices', 'multi must be true or false')
  }
  if (params.multi === true && choices.length === 0) {
    return refuse('invalid-choices', 'multi needs at least one choice')
  }
  let timeoutMs: number | undefined
  if (params.timeoutSeconds !== undefined) {
    const seconds = params.timeoutSeconds
    if (
      typeof seconds !== 'number' ||
      !Number.isFinite(seconds) ||
      seconds < QUESTION_TIMEOUT_MIN_S ||
      seconds > QUESTION_TIMEOUT_MAX_S
    ) {
      return refuse(
        'invalid-timeout',
        `timeout is ${QUESTION_TIMEOUT_MIN_S} to ${QUESTION_TIMEOUT_MAX_S} seconds`,
      )
    }
    timeoutMs = Math.round(seconds * 1000)
  }
  return {
    ok: true,
    content: {
      question: clipTo(question, QUESTION_MAX),
      context: clipTo(context, QUESTION_CONTEXT_MAX),
      choices,
      mode: choices.length === 0 ? 'text' : params.multi === true ? 'multi' : 'single',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  }
}

export function normalizeReply(
  request: Pick<QuestionRequest, 'choices' | 'mode' | 'permission'>,
  raw: unknown,
): QuestionReply | null {
  if (typeof raw !== 'object' || raw === null) return null
  const reply = raw as Record<string, unknown>
  if (typeof reply.text !== 'string' || !Array.isArray(reply.choices)) return null
  const picked = new Set<number>()
  for (const index of reply.choices) {
    if (!Number.isInteger(index) || index < 0 || index >= request.choices.length) return null
    picked.add(index as number)
  }
  if (request.mode !== 'multi' && picked.size > 1) return null
  if (request.permission && picked.size !== 1) return null
  const text = clipTo(plainBlock(reply.text), QUESTION_REPLY_MAX)
  if (picked.size === 0 && !text) return null
  return { choices: [...picked].sort((a, b) => a - b), text }
}
