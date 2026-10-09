const ESC = '\x1b'
const BEL = '\x07'
const STRING_INTRODUCERS = new Set([']', 'P', 'X', '^', '_'])
const PROMPT_MARK = `${ESC}]133;`
const PROMPT_MARK_MAX = 256

export interface PromptMark {
  kind: string
  arg: string | undefined
  start: number
  end: number
}

interface StringEnd {
  bodyEnd: number
  end: number
}

function stringEnd(raw: string, from: number): StringEnd | null {
  for (let i = from; i < raw.length; i++) {
    if (raw[i] === BEL) return { bodyEnd: i, end: i + 1 }
    if (raw[i] !== ESC) continue
    if (raw[i + 1] === undefined) return null
    return { bodyEnd: i, end: raw[i + 1] === '\\' ? i + 2 : i }
  }
  return null
}

function escapeEnd(raw: string, at: number): number {
  const introducer = raw[at + 1]
  if (introducer === undefined) return -1
  if (STRING_INTRODUCERS.has(introducer)) return stringEnd(raw, at + 2)?.end ?? -1
  const csi = introducer === '['
  for (let i = csi ? at + 2 : at + 1; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const final = csi ? code >= 0x40 && code <= 0x7e : code >= 0x30 && code <= 0x7e
    if (final) return i + 1
  }
  return -1
}

export function plainTerminalText(raw: string): { text: string; consumed: number } {
  let text = ''
  let line = ''
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === ESC) {
      const end = escapeEnd(raw, i)
      if (end === -1) break
      i = end
      continue
    }
    if (ch === '\n') {
      text += `${line}\n`
      line = ''
    } else if (ch === '\r') {
      if (raw[i + 1] === undefined) break
      if (raw[i + 1] !== '\n') line = ''
    } else if (ch === '\b') {
      line = line.slice(0, -1)
    } else if (ch === '\t' || (ch >= ' ' && ch !== '\x7f')) {
      line += ch
    }
    i++
  }
  return { text: text + line, consumed: i }
}

function partialMarkSuffix(data: string): string {
  for (let len = Math.min(PROMPT_MARK.length - 1, data.length); len > 0; len--) {
    if (data.endsWith(PROMPT_MARK.slice(0, len))) return data.slice(-len)
  }
  return ''
}

export class PromptMarkScanner {
  private carry = ''

  scan(data: string, endCursor: number): PromptMark[] {
    const combined = this.carry + data
    const base = endCursor - combined.length
    const marks: PromptMark[] = []
    this.carry = ''
    let from = 0
    for (;;) {
      const at = combined.indexOf(PROMPT_MARK, from)
      if (at === -1) {
        this.carry = partialMarkSuffix(combined.slice(from))
        return marks
      }
      const bodyStart = at + PROMPT_MARK.length
      const found = stringEnd(combined, bodyStart)
      if (!found) {
        if (combined.length - at <= PROMPT_MARK_MAX) this.carry = combined.slice(at)
        return marks
      }
      const [kind = '', arg] = combined.slice(bodyStart, found.bodyEnd).split(';')
      marks.push({ kind, arg, start: base + at, end: base + found.end })
      from = Math.max(found.end, bodyStart)
    }
  }
}
