import { type ChordProblem, type ChordSpec, DIGIT_RANGE, parseChord } from './chordSpec'
import { isDangerousSegment } from './protoGuard'

export const TERMINAL_SEND_TYPES = ['text', 'escape', 'hex'] as const

export type TerminalSendType = (typeof TERMINAL_SEND_TYPES)[number]

export interface TerminalSend {
  type: TerminalSendType
  value: string
}

export type TerminalKeyMap = Record<string, TerminalSend | null>

export const TERMINAL_SEND_MAX = 1024

const ESC = '\x1b'

const TEXT_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['e', ESC],
  ['\\', '\\'],
])

function decodeText(value: string): string | null {
  let bad = false
  const out = value.replace(/\\(x[0-7][0-9a-fA-F]|.?)/gs, (_, esc: string) => {
    if (esc.length === 3) return String.fromCharCode(Number.parseInt(esc.slice(1), 16))
    const plain = TEXT_ESCAPES.get(esc)
    if (plain === undefined) bad = true
    return plain ?? ''
  })
  return bad || !out ? null : out
}

function decodeHex(value: string): string | null {
  const tokens = value.split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) return null
  let out = ''
  for (const token of tokens) {
    const byte = /^(?:0x)?([0-7]?[0-9a-f])$/i.exec(token)
    if (!byte) return null
    out += String.fromCharCode(Number.parseInt(byte[1], 16))
  }
  return out
}

export function sendData(send: TerminalSend): string | null {
  if (!send.value || send.value.length > TERMINAL_SEND_MAX) return null
  if (send.type === 'escape') return ESC + send.value
  if (send.type === 'hex') return decodeHex(send.value)
  return decodeText(send.value)
}

export function sameSend(a: TerminalSend, b: TerminalSend): boolean {
  return a.type === b.type && a.value === b.value
}

export function parseTerminalSend(raw: unknown): TerminalSend | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { type, value } = raw as Record<string, unknown>
  if (!TERMINAL_SEND_TYPES.includes(type as TerminalSendType)) return null
  if (typeof value !== 'string') return null
  const send: TerminalSend = { type: type as TerminalSendType, value }
  return sendData(send) === null ? null : send
}

const PLAIN_KEY_PROBLEMS: Readonly<Record<string, ChordProblem>> = {
  escape: 'escape',
  tab: 'tab',
  enter: 'bare',
}

export function sendChordProblem(spec: ChordSpec): ChordProblem | null {
  if (spec.key === DIGIT_RANGE) return 'digit-range'
  if (spec.ctrl || spec.alt || spec.meta) return null
  if (spec.key.length === 1 || spec.key === 'space') return 'bare'
  if (spec.shift) return null
  return Object.hasOwn(PLAIN_KEY_PROBLEMS, spec.key) ? PLAIN_KEY_PROBLEMS[spec.key] : null
}

export function checkSendChord(text: string, mac: boolean): ChordProblem | null {
  const spec = parseChord(text, mac)
  return spec ? sendChordProblem(spec) : 'invalid'
}

export function parseTerminalKeys(raw: unknown): TerminalKeyMap {
  const out: TerminalKeyMap = Object.create(null)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [keys, value] of Object.entries(raw as Record<string, unknown>)) {
    const chord = keys.trim()
    if (!chord || isDangerousSegment(chord)) continue
    if (!parseChord(chord, true) && !parseChord(chord, false)) continue
    if (value === null) {
      out[chord] = null
      continue
    }
    const send = parseTerminalSend(value)
    if (send) out[chord] = send
  }
  return out
}
