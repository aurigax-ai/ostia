import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { oneLine, plainBlock } from './questions'

export const TURN_HOOK_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'] as const

export type TurnHookEvent = (typeof TURN_HOOK_EVENTS)[number]

const TURN_STEP_KINDS = ['edit', 'command', 'search', 'read', 'subagent', 'web', 'other'] as const

export type TurnStepKind = (typeof TURN_STEP_KINDS)[number]

export const TURN_PROMPT_MAX = 8000
const TURN_TARGET_MAX = 200
const TURN_FINAL_MAX = 16 * 1024
export const TURN_OUTPUT_MAX = 16 * 1024
const EXIT_CODE_MAX = 255

export type TurnReport =
  | { kind: 'prompt'; text: string }
  | { kind: 'step'; step: TurnStepKind; target?: string; exitCode?: number; output?: string }
  | { kind: 'stop'; message?: string }

const STEP_TOOLS: Record<string, { step: TurnStepKind; fields: string[] }> = {
  Edit: { step: 'edit', fields: ['file_path'] },
  MultiEdit: { step: 'edit', fields: ['file_path'] },
  Write: { step: 'edit', fields: ['file_path'] },
  NotebookEdit: { step: 'edit', fields: ['notebook_path'] },
  apply_patch: { step: 'edit', fields: ['path', 'file_path'] },
  Bash: { step: 'command', fields: ['command'] },
  shell: { step: 'command', fields: ['command'] },
  Grep: { step: 'search', fields: ['pattern'] },
  Glob: { step: 'search', fields: ['pattern'] },
  Read: { step: 'read', fields: ['file_path'] },
  Task: { step: 'subagent', fields: ['description'] },
  Agent: { step: 'subagent', fields: ['description'] },
  WebFetch: { step: 'web', fields: ['url'] },
  WebSearch: { step: 'web', fields: ['query'] },
}

const ESC = '\u001b'
const BEL = '\u0007'
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?)`,
  'g',
)

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function capped(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max).join('') : text
}

function tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  return bytes
    .subarray(bytes.length - maxBytes)
    .toString('utf8')
    .replace(/^�+/, '')
}

function commandText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(' ')
  }
  return ''
}

function stepTarget(input: unknown, fields: string[]): string | undefined {
  const fieldsIn = record(input)
  for (const field of fields) {
    const raw = field === 'command' ? commandText(fieldsIn[field]) : fieldsIn[field]
    if (typeof raw !== 'string') continue
    const line = capped(
      oneLine(raw.split('\n').find((l) => l.trim() !== '') ?? ''),
      TURN_TARGET_MAX,
    )
    if (line) return line
  }
  return undefined
}

function exitCodeOf(response: Record<string, unknown>): number | undefined {
  for (const field of ['exit_code', 'exitCode', 'returncode']) {
    const code = response[field]
    if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= EXIT_CODE_MAX) {
      return code
    }
  }
  return undefined
}

function outputOf(raw: unknown): string {
  if (typeof raw === 'string') return raw
  const response = record(raw)
  const parts = ['stdout', 'stderr', 'output', 'aggregated_output']
    .map((field) => response[field])
    .filter((part): part is string => typeof part === 'string' && part !== '')
  return parts.join('\n')
}

function cleanOutput(text: string): string {
  return tail(plainBlock(text.replace(ANSI, '')), TURN_OUTPUT_MAX)
}

export function turnReportOf(event: TurnHookEvent, stdin: string): TurnReport | null {
  let payload: Record<string, unknown>
  try {
    payload = record(JSON.parse(stdin))
  } catch {
    return null
  }
  if (event === 'UserPromptSubmit') {
    const text = typeof payload.prompt === 'string' ? plainBlock(payload.prompt) : ''
    return text ? { kind: 'prompt', text: capped(text, TURN_PROMPT_MAX) } : null
  }
  if (event === 'Stop') {
    const message = payload.last_assistant_message
    const text = typeof message === 'string' ? plainBlock(message) : ''
    return text ? { kind: 'stop', message: capped(text, TURN_FINAL_MAX) } : { kind: 'stop' }
  }
  const name = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  if (!name) return null
  const known = STEP_TOOLS[name]
  const step: TurnStepKind = known?.step ?? 'other'
  const target = known
    ? stepTarget(payload.tool_input, known.fields)
    : capped(oneLine(name), TURN_TARGET_MAX) || undefined
  if (step !== 'command') return { kind: 'step', step, ...(target ? { target } : {}) }
  const response = payload.tool_response
  const exitCode = exitCodeOf(record(response))
  const output = cleanOutput(outputOf(response))
  return {
    kind: 'step',
    step,
    ...(target ? { target } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(output ? { output } : {}),
  }
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = plainBlock(value)
  return text ? capped(text, max) : undefined
}

export function normalizeTurnReport(raw: unknown): TurnReport | null {
  const src = record(raw)
  if (src.kind === 'prompt') {
    const text = boundedText(src.text, TURN_PROMPT_MAX)
    return text ? { kind: 'prompt', text } : null
  }
  if (src.kind === 'stop') {
    const message = boundedText(src.message, TURN_FINAL_MAX)
    return message ? { kind: 'stop', message } : { kind: 'stop' }
  }
  if (src.kind === 'step') {
    if (!TURN_STEP_KINDS.includes(src.step as TurnStepKind)) return null
    const step = src.step as TurnStepKind
    const target =
      typeof src.target === 'string' ? capped(oneLine(src.target), TURN_TARGET_MAX) : ''
    const code = src.exitCode
    const exitCode =
      step === 'command' &&
      typeof code === 'number' &&
      Number.isInteger(code) &&
      code >= 0 &&
      code <= EXIT_CODE_MAX
        ? code
        : undefined
    const output =
      step === 'command' && typeof src.output === 'string' ? cleanOutput(src.output) : ''
    return {
      kind: 'step',
      step,
      ...(target ? { target } : {}),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(output ? { output } : {}),
    }
  }
  return null
}

export function isTurnHookEvent(value: unknown): value is TurnHookEvent {
  return typeof value === 'string' && (TURN_HOOK_EVENTS as readonly string[]).includes(value)
}
