import {
  type ChordSpec,
  DIGIT_RANGE,
  formatChord,
  isNativeClipboardKey,
  parseChord,
  sameChord,
  specFromEvent,
  stealsTerminalKey,
} from './chordSpec'

export type ClipboardEdit = 'copy' | 'paste'

export interface ClipboardChords {
  copy: ChordSpec | null
  paste: ChordSpec | null
}

export const NO_CLIPBOARD_CHORDS: ClipboardChords = { copy: null, paste: null }

export interface GuestKeyInput {
  type: string
  key: string
  code: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

export function isClipboardEdit(value: unknown): value is ClipboardEdit {
  return value === 'copy' || value === 'paste'
}

function normalizeSpec(raw: unknown, mac: boolean): ChordSpec | null | undefined {
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { ctrl, shift, alt, meta, key } = raw as Record<string, unknown>
  const flags = [ctrl, shift, alt, meta]
  if (flags.some((f) => typeof f !== 'boolean') || typeof key !== 'string') return undefined
  if (key === DIGIT_RANGE) return undefined
  const spec: ChordSpec = {
    ctrl: ctrl as boolean,
    shift: shift as boolean,
    alt: alt as boolean,
    meta: meta as boolean,
    key,
  }
  const parsed = parseChord(formatChord(spec, mac), mac)
  if (!parsed || !sameChord(parsed, spec) || stealsTerminalKey(spec, mac)) return undefined
  return spec
}

export function normalizeClipboardChords(raw: unknown, mac: boolean): ClipboardChords | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { copy, paste } = raw as Record<string, unknown>
  const copySpec = normalizeSpec(copy, mac)
  const pasteSpec = normalizeSpec(paste, mac)
  if (copySpec === undefined || pasteSpec === undefined) return null
  return { copy: copySpec, paste: pasteSpec }
}

export function guestClipboardEdit(
  input: GuestKeyInput,
  chords: ClipboardChords,
  mac: boolean,
): ClipboardEdit | null {
  if (input.type !== 'keyDown') return null
  const event = {
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
    metaKey: input.meta,
  }
  if (mac && isNativeClipboardKey(event)) return null
  const spec = specFromEvent(event)
  if (!spec) return null
  if (chords.copy && sameChord(chords.copy, spec)) return 'copy'
  if (chords.paste && sameChord(chords.paste, spec)) return 'paste'
  return null
}
