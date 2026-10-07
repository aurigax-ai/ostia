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

const SEND_ACTIONS: readonly [
  string,
  (
    | 'lineStart'
    | 'lineEnd'
    | 'deleteLine'
    | 'deleteToEnd'
    | 'wordBack'
    | 'wordForward'
    | 'deleteWordBack'
    | 'deleteWordForward'
    | 'deleteChar'
  ),
][] = [
  ['\x01', 'lineStart'],
  ['\x05', 'lineEnd'],
  ['\x15', 'deleteLine'],
  ['\x0b', 'deleteToEnd'],
  ['\x1bb', 'wordBack'],
  ['\x1bf', 'wordForward'],
  ['\x1b\x7f', 'deleteWordBack'],
  ['\x17', 'deleteWordBack'],
  ['\x1bd', 'deleteWordForward'],
  ['\x04', 'deleteChar'],
]

export type SendActionKey = (typeof SEND_ACTIONS)[number][1]

export function sendActionKey(send: TerminalSend): SendActionKey | null {
  const data = sendData(send)
  return SEND_ACTIONS.find(([d]) => d === data)?.[1] ?? null
}
