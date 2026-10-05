import { type ChordProblem, type KeybindingMap, checkBinding } from './chordSpec'
import { isDangerousSegment } from './protoGuard'

export const KEYMAP_FILE_MAX_BYTES = 64 * 1024
export const KEYMAP_COMMAND_MAX = 200
export const KEYMAP_CHORD_MAX = 100

export interface KeymapSkip {
  command: string
  value: string
  problem: ChordProblem
}

export interface LoadedKeymap {
  extId: string
  id: string
  label: string
  bindings: KeybindingMap
  skipped: KeymapSkip[]
}

export type KeymapLoad = { ok: true; keymap: LoadedKeymap } | { ok: false; error: string }

export interface KeymapsApi {
  load: (ref: string) => Promise<KeymapLoad>
}

export type KeymapBindingsResult =
  | { ok: true; bindings: KeybindingMap; skipped: KeymapSkip[] }
  | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text ?? String(value)).slice(0, KEYMAP_CHORD_MAX)
}

export function parseKeymapBindings(raw: unknown, mac: boolean): KeymapBindingsResult {
  if (!isRecord(raw) || !isRecord(raw.bindings)) {
    return { ok: false, error: 'must be a JSON object with a "bindings" object' }
  }
  const bindings: KeybindingMap = Object.create(null)
  const skipped: KeymapSkip[] = []
  for (const [command, value] of Object.entries(raw.bindings)) {
    const skip = (problem: ChordProblem): void => {
      skipped.push({ command: command.slice(0, KEYMAP_COMMAND_MAX), value: shown(value), problem })
    }
    if (!command || command.length > KEYMAP_COMMAND_MAX || isDangerousSegment(command)) {
      skip('invalid')
      continue
    }
    if (value === null) {
      bindings[command] = null
      continue
    }
    if (typeof value !== 'string' || value.length > KEYMAP_CHORD_MAX) {
      skip('invalid')
      continue
    }
    const chord = value.trim()
    const problem = checkBinding(command, chord, mac)
    if (problem) {
      skip(problem)
      continue
    }
    bindings[command] = chord
  }
  return { ok: true, bindings, skipped }
}
