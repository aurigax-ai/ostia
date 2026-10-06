import {
  type ChordSpec,
  type KeyLike,
  formatChord,
  parseChord,
  specFromEvent,
} from '@shared/chordSpec'
import {
  type TerminalKeyMap,
  type TerminalSend,
  sameSend,
  sendChordProblem,
  sendData,
} from '@shared/terminalKeys'
import { NATURAL_TEXT_EDITING } from '../settings/keymapSetting'
import { useSettingsStore } from '../stores/settingsStore'
import { matchChord } from './chords'

export type PresetKeys = Readonly<Record<string, TerminalSend>>

const hex = (value: string): TerminalSend => ({ type: 'hex', value })
const esc = (value: string): TerminalSend => ({ type: 'escape', value })

export const OSTIA_KEYS: PresetKeys = {
  'Cmd+Backspace': hex('0x15'),
  'Cmd+Left': hex('0x01'),
  'Cmd+Right': hex('0x05'),
  'Alt+Left': esc('b'),
  'Alt+Right': esc('f'),
  'Alt+Backspace': hex('0x1b 0x7f'),
  'Alt+Delete': esc('d'),
  'Cmd+Delete': hex('0x0b'),
}

export const NATURAL_TEXT_EDITING_KEYS: PresetKeys = {
  'Alt+Backspace': hex('0x1b 0x7f'),
  'Alt+Left': esc('b'),
  'Alt+Right': esc('f'),
  'Alt+Delete': esc('d'),
  'Cmd+Backspace': hex('0x15'),
  'Cmd+Left': hex('0x01'),
  'Cmd+Right': hex('0x05'),
  Delete: hex('0x04'),
}

export function presetKeys(keymap: string | null, mac: boolean): PresetKeys {
  if (!mac) return {}
  return keymap === NATURAL_TEXT_EDITING ? NATURAL_TEXT_EDITING_KEYS : OSTIA_KEYS
}

export interface TerminalKeyRow {
  signature: string
  spec: ChordSpec
  send: TerminalSend
  data: string
  preset: TerminalSend | null
  userKey: string | null
}

export interface TerminalKeyTable {
  rows: readonly TerminalKeyRow[]
  bySignature: ReadonlyMap<string, TerminalKeyRow>
}

export function signatureOf(keys: string, mac: boolean): string | null {
  const spec = parseChord(keys, mac)
  return spec ? formatChord(spec, mac) : null
}

export function terminalKeyTable(
  user: TerminalKeyMap,
  keymap: string | null,
  mac: boolean,
): TerminalKeyTable {
  const bySignature = new Map<string, TerminalKeyRow>()
  const presets = new Map<string, TerminalSend>()
  for (const [keys, send] of Object.entries(presetKeys(keymap, mac))) {
    const spec = parseChord(keys, mac)
    const data = sendData(send)
    if (!spec || data === null) continue
    const signature = formatChord(spec, mac)
    presets.set(signature, send)
    bySignature.set(signature, { signature, spec, send, data, preset: send, userKey: null })
  }
  for (const [keys, send] of Object.entries(user)) {
    const spec = parseChord(keys, mac)
    if (!spec || sendChordProblem(spec)) continue
    const signature = formatChord(spec, mac)
    if (send === null) {
      bySignature.delete(signature)
      continue
    }
    const data = sendData(send)
    if (data === null) continue
    const preset = presets.get(signature) ?? null
    bySignature.set(signature, { signature, spec, send, data, preset, userKey: keys })
  }
  return { rows: [...bySignature.values()], bySignature }
}

let cache: {
  user: TerminalKeyMap
  keymap: string | null
  mac: boolean
  table: TerminalKeyTable
} | null = null

export function currentTerminalKeys(mac: boolean): TerminalKeyTable {
  const { terminalKeys: user, keymap } = useSettingsStore.getState()
  if (cache?.user !== user || cache.keymap !== keymap || cache.mac !== mac) {
    cache = { user, keymap, mac, table: terminalKeyTable(user, keymap, mac) }
  }
  return cache.table
}

export function terminalKeyFor(spec: ChordSpec, mac: boolean): TerminalKeyRow | null {
  return currentTerminalKeys(mac).bySignature.get(formatChord(spec, mac)) ?? null
}

export function terminalKeyData(e: KeyLike, mac: boolean): string | null {
  if (matchChord(e, mac)) return null
  const spec = specFromEvent(e)
  return spec ? (terminalKeyFor(spec, mac)?.data ?? null) : null
}

function userKeysFor(signature: string, mac: boolean): string[] {
  const user = useSettingsStore.getState().terminalKeys
  return Object.keys(user).filter((keys) => signatureOf(keys, mac) === signature)
}

export function removeTerminalKey(row: TerminalKeyRow, mac: boolean): void {
  const settings = useSettingsStore.getState()
  for (const keys of userKeysFor(row.signature, mac)) settings.resetTerminalKey(keys)
  if (row.preset) settings.setTerminalKey(row.signature, null)
}

export function resetTerminalKey(row: TerminalKeyRow, mac: boolean): void {
  const settings = useSettingsStore.getState()
  for (const keys of userKeysFor(row.signature, mac)) settings.resetTerminalKey(keys)
}

export function saveTerminalKey(
  spec: ChordSpec,
  send: TerminalSend,
  previous: TerminalKeyRow | null,
  mac: boolean,
): void {
  const settings = useSettingsStore.getState()
  const signature = formatChord(spec, mac)
  if (previous && previous.signature !== signature) removeTerminalKey(previous, mac)
  for (const keys of userKeysFor(signature, mac)) settings.resetTerminalKey(keys)
  const preset = presetKeys(settings.keymap, mac)
  const fromPreset = Object.entries(preset).find(([keys]) => signatureOf(keys, mac) === signature)
  if (fromPreset && sameSend(fromPreset[1], send)) return
  settings.setTerminalKey(signature, send)
}
