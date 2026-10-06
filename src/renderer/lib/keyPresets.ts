import {
  type ChordSpec,
  type KeyLike,
  formatChord,
  parseChord,
  specFromEvent,
} from '@shared/chordSpec'
import {
  type PresetKeys,
  keyboardPlatform,
  terminalKeymapIn,
  terminalKeymapKeys,
} from '@shared/keyboardPresets'
import {
  type TerminalKeyMap,
  type TerminalSend,
  sameSend,
  sendChordProblem,
  sendData,
} from '@shared/terminalKeys'
import { useSettingsStore } from '../stores/settingsStore'
import { isBrowserChord, matchChord } from './chords'

const envOf = (mac: boolean) => ({ platform: mac ? 'darwin' : 'linux' })

export function terminalKeymapOf(chosen: string | null, mac: boolean): string {
  return terminalKeymapIn(chosen, envOf(mac))
}

export function presetKeys(terminalKeymap: string | null, mac: boolean): PresetKeys {
  const env = envOf(mac)
  return terminalKeymapKeys(terminalKeymapIn(terminalKeymap, env), keyboardPlatform(env.platform))
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
  terminalKeymap: string | null,
  mac: boolean,
): TerminalKeyTable {
  const bySignature = new Map<string, TerminalKeyRow>()
  const presets = new Map<string, TerminalSend>()
  for (const [keys, send] of Object.entries(presetKeys(terminalKeymap, mac))) {
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
  terminalKeymap: string | null
  mac: boolean
  table: TerminalKeyTable
} | null = null

export function currentTerminalKeys(mac: boolean): TerminalKeyTable {
  const { terminalKeys: user, terminalKeymap } = useSettingsStore.getState()
  if (cache?.user !== user || cache.terminalKeymap !== terminalKeymap || cache.mac !== mac) {
    cache = { user, terminalKeymap, mac, table: terminalKeyTable(user, terminalKeymap, mac) }
  }
  return cache.table
}

export function terminalKeyFor(spec: ChordSpec, mac: boolean): TerminalKeyRow | null {
  return currentTerminalKeys(mac).bySignature.get(formatChord(spec, mac)) ?? null
}

export function terminalKeyData(e: KeyLike, mac: boolean): string | null {
  const chord = matchChord(e, mac)
  if (chord && !isBrowserChord(chord)) return null
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
  const preset = presetKeys(settings.terminalKeymap, mac)
  const fromPreset = Object.entries(preset).find(([keys]) => signatureOf(keys, mac) === signature)
  if (fromPreset && sameSend(fromPreset[1], send)) return
  settings.setTerminalKey(signature, send)
}
