import { type KeybindingMap, chordText, formatChord, parseChord } from '@shared/chordSpec'
import type { PresetKeys } from '@shared/keyboardPresets'
import { type TerminalSend, sameSend, sendData } from '@shared/terminalKeys'
import { effectiveBindings } from './chords'

export interface TerminalKeyChange {
  keys: string
  signature: string
  before: TerminalSend | null
  after: TerminalSend | null
}

export interface AppKeyChange {
  id: string
  before: string | null
  after: string | null
}

function bySignature(keys: PresetKeys, mac: boolean): Map<string, [string, TerminalSend]> {
  const out = new Map<string, [string, TerminalSend]>()
  for (const [raw, send] of Object.entries(keys)) {
    const spec = parseChord(raw, mac)
    if (spec) out.set(formatChord(spec, mac), [chordText(spec, mac), send])
  }
  return out
}

export function terminalKeyChanges(
  from: PresetKeys,
  to: PresetKeys,
  mac: boolean,
): TerminalKeyChange[] {
  const before = bySignature(from, mac)
  const after = bySignature(to, mac)
  const out: TerminalKeyChange[] = []
  for (const [signature, [keys, send]] of after) {
    const old = before.get(signature)?.[1] ?? null
    if (old && sameSend(old, send)) continue
    out.push({ keys, signature, before: old, after: send })
  }
  for (const [signature, [keys, send]] of before) {
    if (!after.has(signature)) out.push({ keys, signature, before: send, after: null })
  }
  return out
}

function chordsText(bindings: KeybindingMap, id: string, mac: boolean): string | null {
  const specs = effectiveBindings({}, mac, bindings).byId.get(id) ?? []
  return specs.length > 0 ? specs.map((spec) => chordText(spec, mac)).join(' / ') : null
}

export function appKeyChanges(
  from: KeybindingMap,
  to: KeybindingMap,
  mac: boolean,
): AppKeyChange[] {
  const out: AppKeyChange[] = []
  for (const id of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const before = chordsText(from, id, mac)
    const after = chordsText(to, id, mac)
    if (before !== after) out.push({ id, before, after })
  }
  return out
}

const hex = (value: string): TerminalSend => ({ type: 'hex', value })

const ACTION_SENDS = {
  lineStart: hex('0x01'),
  lineEnd: hex('0x05'),
  wordBack: hex('0x1b 0x62'),
  wordForward: hex('0x1b 0x66'),
  deleteChar: hex('0x04'),
  deleteWordBack: hex('0x1b 0x7f'),
  deleteWordForward: hex('0x1b 0x64'),
  deleteToEnd: hex('0x0b'),
  deleteLine: hex('0x15'),
} as const satisfies Record<string, TerminalSend>

export type SendActionKey = keyof typeof ACTION_SENDS

export const SEND_ACTION_KEYS = Object.keys(ACTION_SENDS) as SendActionKey[]

const SEND_ACTION_ALIASES: readonly [string, SendActionKey][] = [['\x17', 'deleteWordBack']]

export function actionSend(key: SendActionKey): TerminalSend {
  return ACTION_SENDS[key]
}

export function sendActionKey(send: TerminalSend): SendActionKey | null {
  const data = sendData(send)
  if (data === null) return null
  const action = SEND_ACTION_KEYS.find((key) => sendData(ACTION_SENDS[key]) === data)
  return action ?? SEND_ACTION_ALIASES.find(([alias]) => alias === data)?.[1] ?? null
}
