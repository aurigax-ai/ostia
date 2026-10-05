import {
  DIGIT_RANGE,
  type KeyLike,
  formatChord,
  isNativeClipboardKey,
  parseChord,
  specFromEvent,
} from './chordSpec'
import type { GuestKeyInput } from './clipboardChords'

export const MAX_GUEST_CHORDS = 512

export interface GuestChordFire {
  guestId: number
  key: KeyLike
}

export function normalizeGuestChords(raw: unknown, mac: boolean): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_GUEST_CHORDS) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return null
    const spec = parseChord(item, mac)
    if (!spec || formatChord(spec, mac) !== item) return null
    out.push(item)
  }
  return out
}

export function guestKeyLike(input: GuestKeyInput): KeyLike {
  return {
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
    metaKey: input.meta,
  }
}

export function guestChordKey(
  input: GuestKeyInput,
  chords: ReadonlySet<string>,
  mac: boolean,
): KeyLike | null {
  if (input.type !== 'keyDown' || chords.size === 0) return null
  const key = guestKeyLike(input)
  if (mac && isNativeClipboardKey(key)) return null
  const spec = specFromEvent(key)
  if (!spec) return null
  if (chords.has(formatChord(spec, mac))) return key
  const digit = /^[1-9]$/.test(spec.key)
  return digit && chords.has(formatChord({ ...spec, key: DIGIT_RANGE }, mac)) ? key : null
}

export function isGuestChordFire(value: unknown): value is GuestChordFire {
  if (value === null || typeof value !== 'object') return false
  const { guestId, key } = value as Record<string, unknown>
  if (typeof guestId !== 'number' || key === null || typeof key !== 'object') return false
  const k = key as Record<string, unknown>
  return (
    typeof k.key === 'string' &&
    ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'].every((m) => typeof k[m] === 'boolean')
  )
}
