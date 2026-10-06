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

export interface TerminalKeymap {
  id: string
  keys: Readonly<Partial<Record<KeyboardPlatform, PresetKeys>>>
}

export interface AppKeymap {
  id: string
  platforms: readonly KeyboardPlatform[]
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
  { id: OSTIA_KEYMAP, keys: { mac: OSTIA_TERMINAL_KEYS } },
  { id: NATURAL_TEXT_EDITING, keys: { mac: NATURAL_TEXT_EDITING_KEYS } },
  { id: NO_TERMINAL_KEYMAP, keys: { mac: {}, linux: {} } },
]

export const APP_KEYMAPS: readonly AppKeymap[] = [{ id: OSTIA_KEYMAP, platforms: ['mac', 'linux'] }]

export function terminalKeymapsFor(platform: KeyboardPlatform): TerminalKeymap[] {
  return TERMINAL_KEYMAPS.filter((k) => k.keys[platform] !== undefined)
}

export function appKeymapsFor(platform: KeyboardPlatform): AppKeymap[] {
  return APP_KEYMAPS.filter((k) => k.platforms.includes(platform))
}

export function isTerminalKeymap(value: unknown): value is string {
  return TERMINAL_KEYMAPS.some((k) => k.id === value)
}

export interface KeyboardDefaults {
  app: string
  terminal: string
}

export interface PlatformDefaults extends KeyboardDefaults {
  desktops?: Readonly<Record<string, KeyboardDefaults>>
}

export const PLATFORM_DEFAULTS: Readonly<Record<KeyboardPlatform, PlatformDefaults>> = {
  mac: { app: OSTIA_KEYMAP, terminal: OSTIA_KEYMAP },
  linux: { app: OSTIA_KEYMAP, terminal: NO_TERMINAL_KEYMAP },
}

export interface KeyboardEnv {
  platform: string
  desktop?: string | null
}

export function defaultPresetFor(
  { platform, desktop }: KeyboardEnv,
  table: Readonly<Record<KeyboardPlatform, PlatformDefaults>> = PLATFORM_DEFAULTS,
): KeyboardDefaults {
  const row = table[keyboardPlatform(platform)]
  const names = (desktop ?? '').toLowerCase().split(':').filter(Boolean)
  const match = names.map((name) => row.desktops?.[name]).find((d) => d !== undefined)
  return match ?? { app: row.app, terminal: row.terminal }
}

export function terminalKeymapIn(chosen: string | null, env: KeyboardEnv): string {
  const offered = terminalKeymapsFor(keyboardPlatform(env.platform)).map((k) => k.id)
  if (chosen !== null && offered.includes(chosen)) return chosen
  return defaultPresetFor(env).terminal
}

export function appKeymapIn(chosen: string | null, env: KeyboardEnv): string {
  return chosen ?? defaultPresetFor(env).app
}

export function terminalKeymapKeys(id: string, platform: KeyboardPlatform): PresetKeys {
  return TERMINAL_KEYMAPS.find((k) => k.id === id)?.keys[platform] ?? {}
}
