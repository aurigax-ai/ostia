import type { StreamEvent } from '../../shared/agents/agentStream'

const PROMPT_MARK = '> '

export class SessionPrinter {
  private atLineStart = true
  private readonly toolNames = new Map<string, string>()
  private readonly sentTexts: string[] = []

  constructor(private readonly write: (text: string) => void) {}

  banner(): void {
    this.line(
      'ostia: connected to the manager session. Ctrl+\\ detaches; the session keeps running.',
    )
    this.write('\n')
    this.prompt()
  }

  prompt(): void {
    this.write(PROMPT_MARK)
    this.atLineStart = false
  }

  typed(text: string): void {
    this.sentTexts.push(text)
    this.write('\n')
    this.atLineStart = true
  }

  failed(message: string): void {
    this.line(`ostia: ${message}`)
    this.prompt()
  }

  waiting(): void {
    this.line('  waiting for approval in the Ostia window')
  }

  events(events: readonly StreamEvent[]): void {
    for (const event of events) this.event(event)
  }

  private event(event: StreamEvent): void {
    if (event.type === 'text') {
      this.write(event.text)
      this.atLineStart = event.text.endsWith('\n')
    } else if (event.type === 'tool') {
      this.toolNames.set(event.id, event.name)
      this.line(`  ${event.name}`)
    } else if (event.type === 'tool.result' && event.isError) {
      this.line(`  ${this.toolNames.get(event.id) ?? 'tool'}: failed`)
    } else if (event.type === 'prompt') {
      if (this.sentTexts[0] === event.text) this.sentTexts.shift()
      else this.line(`${PROMPT_MARK}${event.text}`)
    } else if (event.type === 'turn.ended') {
      this.line('')
      this.prompt()
    }
  }

  private line(text: string): void {
    if (!this.atLineStart) this.write('\n')
    this.write(`${text}\n`)
    this.atLineStart = true
  }
}

export interface LineInput {
  edit: string
  submitted: string[]
  detach: boolean
}

const ESC = '\x1b'
const CSI_FINAL = /[A-Za-z~]/

export function readLine(buffer: string, chunk: string): { buffer: string; input: LineInput } {
  let line = buffer
  let echo = ''
  let sequence: 'none' | 'start' | 'csi' = 'none'
  const submitted: string[] = []
  for (const char of chunk) {
    if (sequence === 'start') {
      sequence = char === '[' ? 'csi' : 'none'
    } else if (sequence === 'csi') {
      if (CSI_FINAL.test(char)) sequence = 'none'
    } else if (char === ESC) {
      sequence = 'start'
    } else if (char === '\x1c') {
      return { buffer: line, input: { edit: echo, submitted, detach: true } }
    } else if (char === '\r' || char === '\n') {
      submitted.push(line)
      line = ''
    } else if (char === '\x7f' || char === '\b') {
      if (line.length > 0) {
        line = line.slice(0, -1)
        echo += '\b \b'
      }
    } else if (char >= ' ') {
      line += char
      echo += char
    }
  }
  return { buffer: line, input: { edit: echo, submitted, detach: false } }
}
