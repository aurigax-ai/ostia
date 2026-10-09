import { type KeybindingMap, parseKeybindings } from '@shared/keyboard/chordSpec'
import { KEYBOARD_PLATFORMS, type KeyboardPlatform } from '@shared/keyboard/keyboardPresets'
import { type TerminalKeyMap, parseTerminalKeys } from '@shared/keyboard/terminalKeys'
import { parseKeymapSetting, parseTerminalKeymapSetting } from './keymapSetting'

export interface PlatformKeyboard {
  keymap: string | null
  terminalKeymap: string | null
  keybindings: KeybindingMap
  terminalKeys: TerminalKeyMap
}

export type KeyboardElsewhere = Partial<Record<KeyboardPlatform, PlatformKeyboard>>

export const KEYBOARD_FIELDS = ['keymap', 'terminalKeymap', 'keybindings', 'terminalKeys'] as const

export type KeyboardField = (typeof KEYBOARD_FIELDS)[number]

type PerPlatform = Partial<Record<KeyboardPlatform, unknown>>

export type KeyboardFile = Record<KeyboardField, PerPlatform>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function byPlatform(raw: unknown): PerPlatform {
  return isRecord(raw) ? raw : {}
}

export function readKeyboard(
  raw: Partial<Record<KeyboardField, unknown>>,
  here: KeyboardPlatform,
): { current: PlatformKeyboard; elsewhere: KeyboardElsewhere } {
  const parts = {
    keymap: byPlatform(raw.keymap),
    terminalKeymap: byPlatform(raw.terminalKeymap),
    keybindings: byPlatform(raw.keybindings),
    terminalKeys: byPlatform(raw.terminalKeys),
  }
  const read = (p: KeyboardPlatform): PlatformKeyboard => ({
    keymap: parseKeymapSetting(parts.keymap[p]),
    terminalKeymap: parseTerminalKeymapSetting(parts.terminalKeymap[p]),
    keybindings: parseKeybindings(parts.keybindings[p]),
    terminalKeys: parseTerminalKeys(parts.terminalKeys[p]),
  })
  const elsewhere: KeyboardElsewhere = {}
  for (const p of KEYBOARD_PLATFORMS) {
    if (p !== here && KEYBOARD_FIELDS.some((f) => parts[f][p] !== undefined)) elsewhere[p] = read(p)
  }
  return { current: read(here), elsewhere }
}

export function writeKeyboard(
  current: PlatformKeyboard,
  elsewhere: KeyboardElsewhere,
  here: KeyboardPlatform,
): KeyboardFile {
  const out: KeyboardFile = { keymap: {}, terminalKeymap: {}, keybindings: {}, terminalKeys: {} }
  for (const p of KEYBOARD_PLATFORMS) {
    const k = p === here ? current : elsewhere[p]
    if (!k) continue
    if (k.keymap !== null) out.keymap[p] = k.keymap
    if (k.terminalKeymap !== null) out.terminalKeymap[p] = k.terminalKeymap
    if (Object.keys(k.keybindings).length > 0) out.keybindings[p] = { ...k.keybindings }
    if (Object.keys(k.terminalKeys).length > 0) out.terminalKeys[p] = { ...k.terminalKeys }
  }
  return out
}
