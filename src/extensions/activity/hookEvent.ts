import type { AgentHookEvent, HookAgent } from '../../shared/agentPlugins'

export const TOOL_KINDS = ['edit', 'command', 'search', 'read', 'subagent', 'web', 'other'] as const

export type ToolKind = (typeof TOOL_KINDS)[number]

export const ACTIVITY_KINDS = ['prompt', 'tool', 'stop'] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export const JOURNAL_VERSION = 1

export interface ActivityEvent {
  v: typeof JOURNAL_VERSION
  t: number
  pane: string
  agent: HookAgent
  session: string
  kind: ActivityKind
  tool?: ToolKind
  text?: string
}

export const PROMPT_TEXT_MAX = 200
export const TARGET_TEXT_MAX = 200
export const RECAP_TEXT_MAX = 600
export const RECAP_LINES_MAX = 4
export const SESSION_ID_MAX = 80

const ELLIPSIS = '…'
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

const TOOL_TARGETS: Record<string, { kind: ToolKind; fields: string[] }> = {
  Edit: { kind: 'edit', fields: ['file_path'] },
  MultiEdit: { kind: 'edit', fields: ['file_path'] },
  Write: { kind: 'edit', fields: ['file_path'] },
  NotebookEdit: { kind: 'edit', fields: ['notebook_path'] },
  apply_patch: { kind: 'edit', fields: ['path', 'file_path'] },
  Bash: { kind: 'command', fields: ['command'] },
  shell: { kind: 'command', fields: ['command'] },
  Grep: { kind: 'search', fields: ['pattern'] },
  Glob: { kind: 'search', fields: ['pattern'] },
  Read: { kind: 'read', fields: ['file_path'] },
  Task: { kind: 'subagent', fields: ['description'] },
  Agent: { kind: 'subagent', fields: ['description'] },
  WebFetch: { kind: 'web', fields: ['url'] },
  WebSearch: { kind: 'web', fields: ['query'] },
}

const PATH_FIELDS = ['file_path', 'notebook_path', 'path']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withoutControls(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out
}

export function capped(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}${ELLIPSIS}` : text
}

export function firstLine(text: string, max: number): string {
  const line =
    text
      .split('\n')
      .map((l) => withoutControls(l).trim())
      .find((l) => l !== '') ?? ''
  return capped(line, max)
}

export function recapOf(message: string): string {
  const lines = message
    .split('\n')
    .map((l) => withoutControls(l).trim())
    .filter((l) => l !== '')
  const kept = lines.slice(0, RECAP_LINES_MAX).join('\n')
  const cut = capped(kept, RECAP_TEXT_MAX)
  return lines.length > RECAP_LINES_MAX && !cut.endsWith(ELLIPSIS) ? `${cut}${ELLIPSIS}` : cut
}

function commandText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(' ')
  }
  return ''
}

function insideCwd(path: string, cwd: unknown): string {
  if (typeof cwd !== 'string' || cwd === '' || cwd === '/') return path
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function toolTarget(input: unknown, fields: string[], cwd: unknown): string {
  if (!isRecord(input)) return ''
  for (const field of fields) {
    const raw = field === 'command' ? commandText(input[field]) : input[field]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    return firstLine(PATH_FIELDS.includes(field) ? insideCwd(raw, cwd) : raw, TARGET_TEXT_MAX)
  }
  return ''
}

function sessionOf(raw: unknown): string {
  return typeof raw === 'string' && raw.length <= SESSION_ID_MAX && SESSION_ID_PATTERN.test(raw)
    ? raw
    : ''
}

export interface HookSource {
  agent: HookAgent
  event: AgentHookEvent
  pane: string
  now: number
}

export function parseHookEvent(source: HookSource, stdin: string): ActivityEvent | null {
  let payload: unknown
  try {
    payload = JSON.parse(stdin)
  } catch {
    return null
  }
  if (!isRecord(payload)) return null
  const base = {
    v: JOURNAL_VERSION,
    t: source.now,
    pane: source.pane,
    agent: source.agent,
    session: sessionOf(payload.session_id),
  } as const
  if (source.event === 'UserPromptSubmit') {
    const text =
      typeof payload.prompt === 'string' ? firstLine(payload.prompt, PROMPT_TEXT_MAX) : ''
    return text ? { ...base, kind: 'prompt', text } : { ...base, kind: 'prompt' }
  }
  if (source.event === 'PreToolUse') {
    const name = typeof payload.tool_name === 'string' ? payload.tool_name : ''
    if (name === '') return null
    const known = TOOL_TARGETS[name]
    if (!known)
      return { ...base, kind: 'tool', tool: 'other', text: firstLine(name, TARGET_TEXT_MAX) }
    const text = toolTarget(payload.tool_input, known.fields, payload.cwd)
    return text
      ? { ...base, kind: 'tool', tool: known.kind, text }
      : { ...base, kind: 'tool', tool: known.kind }
  }
  if (source.event === 'Stop') {
    const message = payload.last_assistant_message
    const text = typeof message === 'string' ? recapOf(message) : ''
    return text ? { ...base, kind: 'stop', text } : { ...base, kind: 'stop' }
  }
  return null
}

export function parseStoredEvent(raw: unknown): ActivityEvent | null {
  if (!isRecord(raw) || raw.v !== JOURNAL_VERSION) return null
  const { t, pane, agent, session, kind, tool, text } = raw
  if (typeof t !== 'number' || !Number.isFinite(t)) return null
  if (typeof pane !== 'string' || pane === '' || typeof session !== 'string') return null
  if (agent !== 'claude' && agent !== 'codex') return null
  if (!ACTIVITY_KINDS.includes(kind as ActivityKind)) return null
  if (text !== undefined && typeof text !== 'string') return null
  const event: ActivityEvent = {
    v: JOURNAL_VERSION,
    t,
    pane,
    agent,
    session,
    kind: kind as ActivityKind,
  }
  if (kind === 'tool') {
    if (!TOOL_KINDS.includes(tool as ToolKind)) return null
    event.tool = tool as ToolKind
  }
  if (text) event.text = text
  return event
}
