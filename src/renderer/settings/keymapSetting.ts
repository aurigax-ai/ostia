export const KEYMAP_REF_PATTERN = /^[a-z][a-z0-9-]{1,39}\/[a-z][a-z0-9-]{0,39}$/

export const NATURAL_TEXT_EDITING = 'natural-text-editing'

export const BUILTIN_KEYMAPS: readonly string[] = [NATURAL_TEXT_EDITING]

export const KEYMAP_SETTING_PATTERN = new RegExp(
  `^(?:${BUILTIN_KEYMAPS.join('|')}|${KEYMAP_REF_PATTERN.source.slice(1, -1)})$`,
)

export function parseKeymapSetting(raw: unknown): string | null {
  return typeof raw === 'string' && KEYMAP_SETTING_PATTERN.test(raw) ? raw : null
}

export function keymapSettingValue(value: unknown): string | null {
  if (value === null) return null
  if (typeof value === 'string' && KEYMAP_SETTING_PATTERN.test(value)) return value
  throw new Error(
    'keymap must be null, "natural-text-editing" or "<extension id>/<keymap id>", ' +
      'e.g. "keymap-macos/cmux"',
  )
}
