import type { TerminalSend } from './terminalKeys'

export const KEYBOARD_PLATFORMS = ['mac', 'linux'] as const

export type KeyboardPlatform = (typeof KEYBOARD_PLATFORMS)[number]

export function keyboardPlatform(platform: string): KeyboardPlatform {
  return platform === 'darwin' ? 'mac' : 'linux'
}

export function isKeyboardPlatform(value: unknown): value is KeyboardPlatform {
  return KEYBOARD_PLATFORMS.includes(value as KeyboardPlatform)
}

export type PresetKeys = Readonly<Record<string, TerminalSend>>

interface TerminalKeymap {
  id: string
  keys: Readonly<Partial<Record<KeyboardPlatform, PresetKeys>>>
}

const hex = (value: string): TerminalSend => ({ type: 'hex', value })
const esc = (value: string): TerminalSend => ({ type: 'escape', value })

export const OSTIA_KEYMAP = 'ostia'
export const NATURAL_TEXT_EDITING = 'natural-text-editing'
export const NO_TERMINAL_KEYMAP = 'none'

export const OSTIA_TERMINAL_KEYS: PresetKeys = {
  'Cmd+Backspace': hex('0x15'),
  'Cmd+Left': hex('0x01'),
  'Cmd+Right': hex('0x05'),
  'Alt+Left': esc('b'),
  'Alt+Right': esc('f'),
  'Alt+Backspace': hex('0x1b 0x7f'),
  'Alt+Delete': esc('d'),
  'Cmd+Delete': hex('0x0b'),
}

export const OSTIA_LINUX_TERMINAL_KEYS: PresetKeys = {
  'Ctrl+Left': esc('b'),
  'Ctrl+Right': esc('f'),
  'Alt+Left': esc('b'),
  'Alt+Right': esc('f'),
  'Ctrl+Backspace': hex('0x17'),
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

export const TERMINAL_KEYMAPS: readonly TerminalKeymap[] = [
  { id: OSTIA_KEYMAP, keys: { mac: OSTIA_TERMINAL_KEYS, linux: OSTIA_LINUX_TERMINAL_KEYS } },
  { id: NATURAL_TEXT_EDITING, keys: { mac: NATURAL_TEXT_EDITING_KEYS } },
  { id: NO_TERMINAL_KEYMAP, keys: { mac: {}, linux: {} } },
]

export function terminalKeymapsFor(platform: KeyboardPlatform): TerminalKeymap[] {
  return TERMINAL_KEYMAPS.filter((k) => k.keys[platform] !== undefined)
}

export function isTerminalKeymap(value: unknown): value is string {
  return TERMINAL_KEYMAPS.some((k) => k.id === value)
}

export function terminalKeymapIn(chosen: string | null, platform: KeyboardPlatform): string {
  const offered = terminalKeymapsFor(platform).map((k) => k.id)
  return chosen !== null && offered.includes(chosen) ? chosen : OSTIA_KEYMAP
}

export function terminalKeymapKeys(id: string, platform: KeyboardPlatform): PresetKeys {
  return TERMINAL_KEYMAPS.find((k) => k.id === id)?.keys[platform] ?? {}
}
