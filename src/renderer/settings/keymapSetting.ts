export const KEYMAP_REF_PATTERN = /^[a-z][a-z0-9-]{1,39}\/[a-z][a-z0-9-]{0,39}$/

export function parseKeymapSetting(raw: unknown): string | null {
  return typeof raw === 'string' && KEYMAP_REF_PATTERN.test(raw) ? raw : null
}

export function keymapSettingValue(value: unknown): string | null {
  if (value === null) return null
  if (typeof value === 'string' && KEYMAP_REF_PATTERN.test(value)) return value
  throw new Error('keymap must be null or "<extension id>/<keymap id>", e.g. "keymap-macos/cmux"')
}
