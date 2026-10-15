import type {
  AgentHookEvent,
  HookAgent,
} from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { parseAgentStop } from '@aurigax-ai/ostia-extension-sdk/contract/agentStop'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'

const TOOL_KINDS = ['edit', 'command', 'search', 'read', 'subagent', 'web', 'other'] as const

export type ToolKind = (typeof TOOL_KINDS)[number]

const ACTIVITY_KINDS = ['prompt', 'tool', 'stop'] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

const JOURNAL_VERSION = 2

export interface ActivityEvent {
  v: typeof JOURNAL_VERSION
  t: number
  id: string
  pane: string
  agent: HookAgent
  session: string
  kind: ActivityKind
  tool?: ToolKind
  text?: string
}

export interface ActivityNote {
  v: typeof JOURNAL_VERSION
  t: number
  id: string
  pane: string
  kind: 'note'
  text: string
  needsYou?: true
  link?: string
  doneAt?: number
}

export type ActivityRecord = ActivityEvent | ActivityNote

export const NOTE_TEXT_MAX = 2000
export const NOTE_LINK_MAX = 2000
const RECORD_ID_PATTERN = /^[a-z2-7]{10}$/
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function newRecordId(): string {
  return [...globalThis.crypto.getRandomValues(new Uint8Array(10))]
    .map((byte) => BASE32[byte % 32])
    .join('')
}

export function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && RECORD_ID_PATTERN.test(value)
}

export function isOpenNeedsYou(record: ActivityRecord): boolean {
  return record.kind === 'note' && record.needsYou === true && record.doneAt === undefined
}

export const PROMPT_TEXT_MAX = 200
const TARGET_TEXT_MAX = 200
export const RECAP_TEXT_MAX = 600
const RECAP_LINES_MAX = 4
const SESSION_ID_MAX = 80

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

function withoutControls(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out
}

function capped(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}${ELLIPSIS}` : text
}

function firstLine(text: string, max: number): string {
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
    id: newRecordId(),
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
    const message = parseAgentStop(source.agent, stdin)?.message
    const text = message ? recapOf(message) : ''
    return text ? { ...base, kind: 'stop', text } : { ...base, kind: 'stop' }
  }
  return null
}

function parseStoredNote(raw: Record<string, unknown>, t: number, id: string, pane: string) {
  const { text, needsYou, link, doneAt } = raw
  if (typeof text !== 'string' || text === '' || [...text].length > NOTE_TEXT_MAX) return null
  const note: ActivityNote = { v: JOURNAL_VERSION, t, id, pane, kind: 'note', text }
  if (needsYou === true) note.needsYou = true
  if (typeof link === 'string' && link !== '' && link.length <= NOTE_LINK_MAX) note.link = link
  if (typeof doneAt === 'number' && Number.isFinite(doneAt)) note.doneAt = doneAt
  return note
}

export function parseStoredRecord(raw: unknown): ActivityRecord | null {
  if (!isRecord(raw) || raw.v !== JOURNAL_VERSION) return null
  const { t, id, pane, agent, session, kind, tool, text } = raw
  if (typeof t !== 'number' || !Number.isFinite(t)) return null
  if (!isRecordId(id) || typeof pane !== 'string' || pane === '') return null
  if (kind === 'note') return parseStoredNote(raw, t, id, pane)
  if (typeof session !== 'string') return null
  if (agent !== 'claude' && agent !== 'codex') return null
  if (!ACTIVITY_KINDS.includes(kind as ActivityKind)) return null
  if (text !== undefined && typeof text !== 'string') return null
  const event: ActivityEvent = {
    v: JOURNAL_VERSION,
    t,
    id,
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
