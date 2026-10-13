import { OSTIA_KEYMAP, TERMINAL_KEYMAPS, isTerminalKeymap } from '@shared/keyboard/keyboardPresets'

export const KEYMAP_REF_PATTERN = /^[a-z][a-z0-9-]{1,39}\/[a-z][a-z0-9-]{0,39}$/

export const KEYMAP_SETTING_PATTERN = new RegExp(
  `^(?:${OSTIA_KEYMAP}|${KEYMAP_REF_PATTERN.source.slice(1, -1)})$`,
)

export function parseKeymapSetting(raw: unknown): string | null {
  return typeof raw === 'string' && KEYMAP_SETTING_PATTERN.test(raw) ? raw : null
}

export function keymapSettingValue(value: unknown): string | null {
  if (value === null) return null
  if (typeof value === 'string' && KEYMAP_SETTING_PATTERN.test(value)) return value
  throw new Error(
    'keymap must be null, "ostia" or "<extension id>/<keymap id>", e.g. "keymap-macos/cmux"',
  )
}

export function parseTerminalKeymapSetting(raw: unknown): string | null {
  return isTerminalKeymap(raw) ? raw : null
}

export function terminalKeymapSettingValue(value: unknown): string | null {
  if (value === null || isTerminalKeymap(value)) return value
  const ids = TERMINAL_KEYMAPS.map((k) => `"${k.id}"`).join(', ')
  throw new Error(`terminalKeymap must be null or one of ${ids}`)
}
