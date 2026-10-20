import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { oneLine } from './questions'

export interface TranscriptTurn {
  prompt: string
  tools: string[]
  final: string
}

export const TRANSCRIPT_TOOL_MAX = 120
export const TRANSCRIPT_OUT_MAX = 256 * 1024

const NO_ANSWER = '(no answer yet)'
const NOT_A_PROMPT = /^<(local-command|command-name|command-message)/

export function parse(line: string): Record<string, unknown> | null {
  if (!line) return null
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

export function textParts(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '',
    )
    .join('')
}

function toolLine(name: string, input: unknown): string {
  const record = isRecord(input) ? input : {}
  const arg = [
    record.command,
    record.file_path,
    record.path,
    record.pattern,
    record.url,
    record.description,
  ].find((value) => typeof value === 'string' && value.trim() !== '')
  if (typeof arg !== 'string') return name
  const text = oneLine(arg)
  return `${name}: ${text.length > TRANSCRIPT_TOOL_MAX ? `${text.slice(0, TRANSCRIPT_TOOL_MAX - 1)}…` : text}`
}

export function claudeTurns(lines: readonly string[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const line of lines) {
    const entry = parse(line)
    const message = entry && isRecord(entry.message) ? entry.message : null
    if (!entry || !message) continue
    if (entry.type === 'user' && entry.isMeta !== true && entry.isSidechain !== true) {
      const prompt = textParts(message.content)
      if (prompt.trim() && !NOT_A_PROMPT.test(prompt.trimStart())) {
        turns.push({ prompt: prompt.trim(), tools: [], final: '' })
      }
    } else if (entry.type === 'assistant' && entry.isSidechain !== true && turns.length > 0) {
      const turn = turns[turns.length - 1]
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(part)) continue
        if (part.type === 'tool_use' && typeof part.name === 'string') {
          turn.tools.push(toolLine(part.name, part.input))
        } else if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          turn.final = part.text.trim()
        }
      }
    }
  }
  return turns
}

function normalized(type: unknown): string {
  return typeof type === 'string' ? type.replace(/[_-]/g, '').toLowerCase() : ''
}

function codexItemText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

function codexCommand(item: Record<string, unknown>): string {
  const command = Array.isArray(item.command) ? item.command.map(String) : []
  const script = command[command.length - 1]
  return command.length >= 3 && /^-\w*c$/.test(command[command.length - 2])
    ? script
    : command.join(' ')
}

export function codexTurns(lines: readonly string[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const line of lines) {
    const entry = parse(line)
    const payload = entry && isRecord(entry.payload) ? entry.payload : null
    if (!entry || !payload || entry.type !== 'event_msg') continue
    if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
      const turn = turns[turns.length - 1]
      if (turn && payload.last_agent_message.trim()) turn.final = payload.last_agent_message.trim()
      continue
    }
    const item = isRecord(payload.item) ? payload.item : null
    if (payload.type !== 'item_completed' || !item) continue
    const kind = normalized(item.type)
    if (kind === 'usermessage') {
      const prompt = codexItemText(item.content).trim()
      if (prompt) turns.push({ prompt, tools: [], final: '' })
    } else if (turns.length > 0) {
      const turn = turns[turns.length - 1]
      if (kind === 'agentmessage') {
        const text = codexItemText(item.content).trim()
        if (text) turn.final = text
      } else if (kind === 'commandexecution') {
        turn.tools.push(toolLine('shell', { command: codexCommand(item) }))
      }
    }
  }
  return turns
}

export function renderTurns(turns: readonly TranscriptTurn[]): string {
  const text = turns
    .map((turn) =>
      [
        `> ${turn.prompt.replaceAll('\n', '\n> ')}`,
        ...turn.tools.map((tool) => `· ${tool}`),
        turn.final || NO_ANSWER,
      ].join('\n'),
    )
    .join('\n\n')
  return text.length > TRANSCRIPT_OUT_MAX
    ? `(older text cut)\n${text.slice(text.length - TRANSCRIPT_OUT_MAX)}`
    : text
}
