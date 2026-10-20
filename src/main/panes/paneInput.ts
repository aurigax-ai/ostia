export type HumanInputSource = 'key' | 'paste'

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
  return Math.min(at + (kind === 'O' ? 3 : 2), data.length)
}

export class PaneInput {
  private foreign = false
  private pasting = false
  private submitted: { human: boolean; at: number; claimed: Set<string> } | null = null

  constructor(private readonly now: () => number) {}

  note(data: string, source: HumanInputSource | null): void {
    if (source === 'key') this.pasting = false
    let i = 0
    while (i < data.length) {
      const c = data[i]
      if (c === ESC) {
        if (data.startsWith(PASTE_START, i)) this.pasting = true
        else if (data.startsWith(PASTE_END, i)) this.pasting = false
        i = escapeEnd(data, i)
        continue
      }
      i += 1
      if (c === ENTER) {
        if (!this.pasting && source !== 'paste') this.submit()
      } else if (c < ' ' || c === DEL) {
        if (source !== null && LINE_CLEARS.has(c)) this.foreign = false
      } else if (source === null) {
        this.foreign = true
      }
    }
  }

  claimHumanPrompt(claimant: string): boolean {
    const last = this.submitted
    if (!last?.human || this.now() - last.at > HUMAN_PROMPT_WINDOW_MS) return false
    if (last.claimed.has(claimant)) return false
    last.claimed.add(claimant)
    return true
  }

  private submit(): void {
    this.submitted = { human: !this.foreign, at: this.now(), claimed: new Set() }
    this.foreign = false
  }
}
