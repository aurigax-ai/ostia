import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { readSessionLines, type SessionFile } from './sessionFiles'

const AGENT_TEXT_LIMIT = 1500
const RUN_INPUT_LIMIT = 200
export const RUN_RESULT_LIMIT = 160
const TIMELINE_MAX_CHARS = 200_000

type Json = Record<string, unknown>

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function blocks(content: unknown): Json[] {
  return Array.isArray(content) ? content.filter(isRecord) : []
}

export function clip(text: unknown, limit: number): string {
  const flat = String(text).split(/\s+/).filter(Boolean).join(' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

export function clock(record: Json): string {
  const stamp = str(record.timestamp)
  const date = stamp ? new Date(stamp) : null
  if (!date || Number.isNaN(date.getTime())) return '--:--'
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return blocks(content)
    .filter((b) => b.type === 'text')
    .map((b) => str(b.text))
    .join('\n')
}

function lastLine(content: unknown): string {
  const lines = textOf(content)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
  return lines.at(-1) ?? ''
}

function describeCall(block: Json): [string, string] {
  const name = str(block.name)
  const args = isRecord(block.input) ? block.input : {}
  if (name === 'Bash') {
    const summary = str(args.description)
    const command = str(args.command)
    return [name, clip(summary ? `${summary}: ${command}` : command, RUN_INPUT_LIMIT)]
  }
  for (const key of ['file_path', 'path', 'description', 'skill', 'query', 'pattern']) {
    if (key in args) return [name, clip(args[key], RUN_INPUT_LIMIT)]
  }
  return [name, clip(JSON.stringify(args), RUN_INPUT_LIMIT)]
}

function isHuman(record: Json): boolean {
  return isRecord(record.origin) && record.origin.kind === 'human'
}

function parse(line: string): Json | null {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function messageContent(record: Json): unknown {
  return isRecord(record.message) ? record.message.content : undefined
}

function answersOf(record: Json): Json | null {
  const result = record.toolUseResult
  return isRecord(result) && isRecord(result.answers) ? result.answers : null
}

export function timelineOf(file: SessionFile, lines = readSessionLines(file.path)): string[] {
  const calls = new Map<string, [string, string]>()
  const out: string[] = []
  let title = ''
  let cwd = ''
  let branch = ''
  let first: Json | null = null
  let last: Json | null = null
  for (const line of lines) {
    const r = parse(line)
    if (!r || r.isSidechain === true) continue
    if (r.type === 'ai-title') {
      title = str(r.aiTitle) || title
      continue
    }
    if (str(r.timestamp)) {
      first ??= r
      last = r
    }
    branch = str(r.gitBranch) || branch
    cwd = str(r.cwd) || cwd
    if (r.type === 'attachment') {
      const a = isRecord(r.attachment) ? r.attachment : {}
      if (a.type === 'queued_command' && isHuman(a)) {
        out.push(`[${clock(a)}] USER: ${textOf(a.prompt)}`)
      }
      continue
    }
    const content = messageContent(r)
    if (r.type === 'user' && r.isMeta !== true) {
      if (typeof content === 'string') {
        if (isHuman(r)) out.push(`[${clock(r)}] USER: ${content}`)
        continue
      }
      for (const b of blocks(content)) {
        if (b.type !== 'tool_result') continue
        const [name, summary] = calls.get(str(b.tool_use_id)) ?? ['?', '']
        const answers = answersOf(r)
        if (name === 'AskUserQuestion' && answers) {
          for (const [q, a] of Object.entries(answers)) {
            out.push(`[${clock(r)}] USER ANSWER: ${q} → ${String(a)}`)
          }
          continue
        }
        const status = b.is_error === true ? 'error' : 'ok'
        const tail = clip(lastLine(b.content), RUN_RESULT_LIMIT)
        out.push(`[${clock(r)}] RUN ${name}: ${summary} → ${status}${tail ? ` | ${tail}` : ''}`)
      }
    } else if (r.type === 'assistant') {
      for (const b of blocks(content)) {
        if (b.type === 'text' && str(b.text).trim() !== '') {
          out.push(`[${clock(r)}] AGENT: ${clip(b.text, AGENT_TEXT_LIMIT)}`)
        } else if (b.type === 'tool_use') {
          calls.set(str(b.id), describeCall(b))
        }
      }
    }
  }
  const span = first && last ? `${clock(first)} → ${clock(last)}` : 'empty'
  return [
    `# session ${file.id} | ${title || 'untitled'} | ${span} | cwd ${cwd || '?'} | branch ${branch || '?'}`,
    ...out,
  ]
}

export function capTimelines(texts: readonly string[], max = TIMELINE_MAX_CHARS): string {
  const joined = texts.join('\n\n')
  if (joined.length <= max) return joined
  const dropped = joined.length - max
  return `… the first ${dropped} characters are left out; ask for fewer sessions per call to read them\n${joined.slice(dropped)}`
}
