import { isDangerousSegment } from './protoGuard'

export interface ChordSpec {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  key: string
  terminal?: boolean
}

export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type ChordValue = string | readonly string[]

export type KeybindingMap = Record<string, ChordValue | null>

export const CHORDS_PER_COMMAND_MAX = 8

export function chordTexts(value: ChordValue): string[] {
  return typeof value === 'string' ? [value] : [...value]
}

export const DIGIT_RANGE = '1-9'

export type ChordProblem =
  | 'invalid'
  | 'escape'
  | 'tab'
  | 'bare'
  | 'needs-modifier'
  | 'ctrl-key'
  | 'arrow'
  | 'digit-range'

const NAMED_KEYS: Record<string, string> = {
  up: 'up',
  arrowup: 'up',
  '↑': 'up',
  down: 'down',
  arrowdown: 'down',
  '↓': 'down',
  left: 'left',
  arrowleft: 'left',
  '←': 'left',
  right: 'right',
  arrowright: 'right',
  '→': 'right',
  space: 'space',
  ' ': 'space',
  enter: 'enter',
  return: 'enter',
  tab: 'tab',
  escape: 'escape',
  esc: 'escape',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  insert: 'insert',
  shift: 'shift',
  [DIGIT_RANGE]: DIGIT_RANGE,
}

const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`'])

const CODE_KEYS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'space',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Insert: 'insert',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

const MODIFIER_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'OS',
  'AltGraph',
  'Hyper',
  'Super',
])

const KEY_TITLES: Record<string, string> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  space: 'Space',
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  shift: 'Shift',
}

const ARROW_GLYPHS: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→' }

const ARROWS = new Set(['up', 'down', 'left', 'right'])

const CTRL_SAFE_KEYS = new Set([',', '.', ';', "'", '=', 'pageup', 'pagedown', DIGIT_RANGE])

function normalizeKey(raw: string): string | null {
  const lower = raw.toLowerCase()
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower]
  if (/^[a-z0-9]$/.test(lower)) return lower
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower
  if (PUNCTUATION.has(raw)) return raw
  return null
}

export function parseChord(text: string, mac: boolean): ChordSpec | null {
  const parts = text.split('+').map((p) => p.trim())
  if (parts.some((p) => !p)) return null
  const rawKey = parts.pop()
  if (!rawKey) return null
  const spec: ChordSpec = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  for (const part of parts) {
    const mod = part.toLowerCase()
    let flag: keyof Omit<ChordSpec, 'key'>
    if (mod === 'ctrl' || mod === 'control') flag = 'ctrl'
    else if (mod === 'shift') flag = 'shift'
    else if (mod === 'alt' || mod === 'option' || mod === 'opt') flag = 'alt'
    else if (mod === 'cmd' || mod === 'command' || mod === 'meta' || mod === 'super') flag = 'meta'
    else if (mod === 'mod') flag = mac ? 'meta' : 'ctrl'
    else return null
    if (spec[flag]) return null
    spec[flag] = true
  }
  const key = normalizeKey(rawKey)
  if (!key) return null
  spec.key = key
  if (key === 'shift' && !isDoubleShift(spec)) return null
  return spec
}

export const DOUBLE_SHIFT = 'Shift+Shift'

export const DOUBLE_SHIFT_MS = 300

export const DOUBLE_SHIFT_KEY: KeyLike = {
  key: 'Shift',
  code: 'ShiftLeft',
  ctrlKey: false,
  metaKey: false,
  shiftKey: true,
  altKey: false,
}

export function isDoubleShift(spec: ChordSpec): boolean {
  return spec.key === 'shift' && spec.shift && !spec.ctrl && !spec.alt && !spec.meta
}

export function isDoubleShiftKey(e: KeyLike): boolean {
  return e.key === 'Shift'
}

export interface TapKey {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  repeat?: boolean
  isComposing?: boolean
}

export interface DoubleShiftDetector {
  down: (e: TapKey, now: number) => void
  up: (e: TapKey, now: number) => boolean
  reset: () => void
}

export function doubleShiftDetector(windowMs = DOUBLE_SHIFT_MS): DoubleShiftDetector {
  let downAt: number | null = null
  let tappedAt: number | null = null
  let armed = false
  const reset = (): void => {
    downAt = null
    tappedAt = null
    armed = false
  }
  return {
    down: (e, now) => {
      const lone = e.key === 'Shift' && !e.ctrlKey && !e.metaKey && !e.altKey
      if (!lone || e.repeat || e.isComposing) {
        reset()
        return
      }
      armed = tappedAt !== null && now - tappedAt <= windowMs
      tappedAt = null
      downAt = now
    },
    up: (e, now) => {
      if (e.key !== 'Shift') return false
      const tap = downAt !== null && now - downAt <= windowMs
      const second = armed
      reset()
      if (!tap) return false
      if (second) return true
      tappedAt = now
      return false
    },
    reset,
  }
}

const metaName = (mac: boolean): string => (mac ? 'Cmd' : 'Super')

const keyTitle = (key: string): string =>
  KEY_TITLES[key] ?? (/^[a-z]$|^f\d+$/.test(key) ? key.toUpperCase() : key)

export function formatChord(spec: ChordSpec, mac: boolean): string {
  const parts: string[] = []
  if (spec.ctrl) parts.push('Ctrl')
  if (spec.shift) parts.push('Shift')
  if (spec.alt) parts.push('Alt')
  if (spec.meta) parts.push(metaName(mac))
  parts.push(keyTitle(spec.key))
  return parts.join('+')
}

export function chordText(spec: ChordSpec, mac: boolean): string {
  const key = ARROW_GLYPHS[spec.key] ?? keyTitle(spec.key)
  if (!mac) {
    const parts: string[] = []
    if (spec.ctrl) parts.push('Ctrl')
    if (spec.shift) parts.push('Shift')
    if (spec.alt) parts.push('Alt')
    if (spec.meta) parts.push('Super')
    parts.push(key)
    return parts.join('+')
  }
  if (isDoubleShift(spec)) return '⇧⇧'
  return `${spec.ctrl ? '⌃' : ''}${spec.alt ? '⌥' : ''}${spec.meta ? '⌘' : ''}${spec.shift ? '⇧' : ''}${key}`
}

export function sameChord(a: ChordSpec, b: ChordSpec): boolean {
  return (
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt &&
    a.meta === b.meta &&
    a.key === b.key
  )
}

export function overlaps(a: ChordSpec, b: ChordSpec): boolean {
  if (sameChord(a, b)) return true
  const mods = a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta
  if (!mods) return false
  const digit = (k: string): boolean => /^[1-9]$/.test(k)
  return (a.key === DIGIT_RANGE && digit(b.key)) || (b.key === DIGIT_RANGE && digit(a.key))
}

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

function eventKey(e: KeyLike): string | null {
  const lower = e.key.toLowerCase()
  if (/^[a-z]$/.test(lower)) return lower
  const code = e.code ?? ''
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)
  if (digit) return digit[1]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase()
  if (CODE_KEYS[code]) return CODE_KEYS[code]
  return normalizeKey(e.key)
}

export function specFromEvent(e: KeyLike): ChordSpec | null {
  if (isModifierKey(e.key)) return null
  const key = eventKey(e)
  if (!key) return null
  return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, key }
}

export function stealsTerminalKey(spec: ChordSpec, mac: boolean): ChordProblem | null {
  if (spec.key === 'escape') return 'escape'
  if (spec.key === 'tab') return spec.ctrl && !spec.alt && !spec.meta ? null : 'tab'
  if (!spec.ctrl && !spec.shift && !spec.alt && !spec.meta) return 'bare'
  if (mac) return spec.meta ? null : 'needs-modifier'
  if (!spec.ctrl && !spec.meta) return 'needs-modifier'
  const ctrlOnly = spec.ctrl && !spec.shift && !spec.alt && !spec.meta
  if (!ctrlOnly) return null
  if (ARROWS.has(spec.key)) return 'arrow'
  if (/^[0-9]$/.test(spec.key) || /^f\d+$/.test(spec.key) || CTRL_SAFE_KEYS.has(spec.key)) {
    return null
  }
  return 'ctrl-key'
}

export const WORKSPACE_GOTO = 'workspace.goto'

export const BROWSER_CHORD_IDS = [
  'browser.focusAddress',
  'browser.reload',
  'browser.back',
  'browser.forward',
] as const

const BROWSER_IDS: ReadonlySet<string> = new Set(BROWSER_CHORD_IDS)

const notShellOwned = (spec: ChordSpec): boolean => spec.key !== 'escape' && spec.key !== 'tab'

const altChord = (spec: ChordSpec): boolean =>
  spec.alt && !spec.ctrl && !spec.meta && notShellOwned(spec)

const ctrlChord = (spec: ChordSpec): boolean =>
  spec.ctrl && !spec.alt && !spec.shift && !spec.meta && notShellOwned(spec)

export function bindingProblem(id: string, spec: ChordSpec, mac: boolean): ChordProblem | null {
  if (isDoubleShift(spec)) return spec.terminal || BROWSER_IDS.has(id) ? 'invalid' : null
  const browserOnly = BROWSER_IDS.has(id) && (altChord(spec) || ctrlChord(spec))
  const steal = browserOnly ? null : stealsTerminalKey(spec, mac)
  if (steal) return steal
  const isRange = spec.key === DIGIT_RANGE
  return isRange === (id === WORKSPACE_GOTO) ? null : 'digit-range'
}

export const TERMINAL_SCOPE = 'terminal:'

export function parseScopedChord(text: string, mac: boolean): ChordSpec | null {
  const trimmed = text.trim()
  const terminal = trimmed.toLowerCase().startsWith(TERMINAL_SCOPE)
  const spec = parseChord(terminal ? trimmed.slice(TERMINAL_SCOPE.length) : trimmed, mac)
  return spec && terminal ? { ...spec, terminal: true } : spec
}

export function formatScopedChord(spec: ChordSpec, mac: boolean): string {
  return `${spec.terminal ? TERMINAL_SCOPE : ''}${formatChord(spec, mac)}`
}

export function sameScope(a: ChordSpec, b: ChordSpec): boolean {
  return Boolean(a.terminal) === Boolean(b.terminal)
}

export function checkBinding(id: string, text: string, mac: boolean): ChordProblem | null {
  const spec = parseScopedChord(text, mac)
  return spec ? bindingProblem(id, spec, mac) : 'invalid'
}

const MONACO_OTHER = [
  ...'ACGIKLMORZ'.split('').map((k) => `Ctrl+Shift+${k}`),
  'Ctrl+Shift+[',
  'Ctrl+Shift+]',
  'Ctrl+Shift+\\',
  'Ctrl+Shift+Space',
  'Ctrl+Shift+Enter',
  'Ctrl+Enter',
  'Ctrl+Alt+Up',
  'Ctrl+Alt+Down',
  'Ctrl+F2',
  'Ctrl+F12',
  'Ctrl+Shift+F12',
]

const MONACO_MAC = [
  ...'ACDFGLSVXZ/[]'.split('').map((k) => `Cmd+${k}`),
  ...'KLZG[]\\'.split('').map((k) => `Shift+Cmd+${k}`),
  'Alt+Cmd+F',
  'Cmd+Enter',
  'Shift+Cmd+Enter',
  'Alt+Cmd+Up',
  'Alt+Cmd+Down',
  'Cmd+F2',
  'Cmd+F12',
]

const monacoCache = new Map<boolean, ChordSpec[]>()

function monacoDefaults(mac: boolean): ChordSpec[] {
  const cached = monacoCache.get(mac)
  if (cached) return cached
  const specs = (mac ? MONACO_MAC : MONACO_OTHER)
    .map((text) => parseChord(text, mac))
    .filter((s): s is ChordSpec => s !== null)
  monacoCache.set(mac, specs)
  return specs
}

export function usedByMonaco(spec: ChordSpec, mac: boolean): boolean {
  return monacoDefaults(mac).some((m) => sameChord(m, spec))
}

const parsesSomewhere = (text: string): boolean =>
  parseScopedChord(text, true) !== null || parseScopedChord(text, false) !== null

export function parseChordValue(value: unknown): ChordValue | null {
  if (typeof value === 'string') return parsesSomewhere(value) ? value.trim() : null
  if (!Array.isArray(value)) return null
  const texts = value
    .filter((v): v is string => typeof v === 'string' && parsesSomewhere(v))
    .map((v) => v.trim())
  const unique = [...new Set(texts)].slice(0, CHORDS_PER_COMMAND_MAX)
  return unique.length > 0 ? unique : null
}

export function parseKeybindings(raw: unknown): KeybindingMap {
  const out: KeybindingMap = Object.create(null)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || isDangerousSegment(id)) continue
    if (value === null) {
      out[id] = null
      continue
    }
    const chords = parseChordValue(value)
    if (chords !== null) out[id] = chords
  }
  return out
}

export function isNativeClipboardKey(e: KeyLike): boolean {
  const spec = specFromEvent(e)
  return (
    spec?.meta === true &&
    !spec.ctrl &&
    !spec.alt &&
    !spec.shift &&
    (spec.key === 'c' || spec.key === 'v')
  )
}
