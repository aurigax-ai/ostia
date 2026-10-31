import type { HumanInputSource } from '../../shared/terminal/ptyApi'

export const HUMAN_PROMPT_WINDOW_MS = 10_000

const ESC = '\x1b'
const DEL = '\x7f'
const ENTER = '\r'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const LINE_CLEARS = new Set(['\x03', '\x15'])

export function humanInputSource(raw: unknown): HumanInputSource | null {
  return raw === 'key' || raw === 'paste' ? raw : null
}

function escapeEnd(data: string, at: number): number {
  const kind = data[at + 1]
  if (kind === '[') {
    if (data[at + 2] === 'M') return Math.min(at + 6, data.length)
    let i = at + 2
    while (i < data.length && data[i] >= '0' && data[i] <= '?') i++
    while (i < data.length && data[i] >= ' ' && data[i] <= '/') i++
    return Math.min(i + 1, data.length)
  }
  if (kind === ']' || kind === 'P') {
    let i = at + 2
    while (i < data.length && data[i] !== '\x07' && !data.startsWith('\x1b\\', i)) i++
    return Math.min(i + (data[i] === '\x07' ? 1 : 2), data.length)
  }
  return Math.min(at + (kind === 'O' ? 3 : 2), data.length)
}

export class PaneInput {
  private foreign = false
  private pasting = false
  private edited = false
  private text: string[] = []
  private submitted: { human: boolean; text: string; at: number; claimed: Set<string> } | null =
    null
  private noted = 0

  constructor(private readonly now: () => number) {}

  get writes(): number {
    return this.noted
  }

  drafting(): boolean {
    return this.text.length > 0 || this.edited || this.foreign
  }

  note(data: string, source: HumanInputSource | null): void {
    this.noted += 1
    if (source === 'key') this.pasting = false
    let i = 0
    while (i < data.length) {
      const c = data[i]
      if (c === ESC) {
        if (data.startsWith(PASTE_START, i)) this.pasting = true
        else if (data.startsWith(PASTE_END, i)) this.pasting = false
        else if (source !== null) this.edited = true
        i = escapeEnd(data, i)
        continue
      }
      const point = String.fromCodePoint(data.codePointAt(i) ?? 0)
      i += point.length
      if (c === ENTER) {
        if (source === null && this.text.length > 0) this.foreign = true
        if (!this.pasting && source !== 'paste') this.submit()
        else if (source !== null) this.text.push('\n')
      } else if (c === DEL) {
        if (source !== null) this.text.pop()
      } else if (c < ' ') {
        if (source === null) continue
        if (LINE_CLEARS.has(c)) {
          this.foreign = false
          this.edited = false
          this.text = []
        } else if (c === '\n') this.text.push('\n')
        else this.edited = true
      } else if (source === null) {
        this.foreign = true
      } else {
        this.text.push(point)
      }
    }
  }

  claimHumanPrompt(claimant: string): string | null {
    const last = this.submitted
    if (!last?.human || !last.text || this.now() - last.at > HUMAN_PROMPT_WINDOW_MS) return null
    if (last.claimed.has(claimant)) return null
    last.claimed.add(claimant)
    return last.text
  }

  private submit(): void {
    const text = this.text.join('').trim()
    this.submitted = {
      human: !this.foreign && !this.edited,
      text,
      at: this.now(),
      claimed: new Set(),
    }
    this.foreign = false
    this.edited = false
    this.text = []
  }
}
