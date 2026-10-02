export const GLOBAL_HOTKEY_MAX_LENGTH = 64

const MODIFIERS: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  cmd: 'Command',
  command: 'Command',
  mod: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  commandorcontrol: 'CommandOrControl',
}

const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  delete: 'Delete',
  backspace: 'Backspace',
  enter: 'Enter',
}

const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`'])

function acceleratorKey(raw: string): string | null {
  const lower = raw.toLowerCase()
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower]
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase()
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase()
  if (PUNCTUATION.has(raw)) return raw
  return null
}

export function toAccelerator(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > GLOBAL_HOTKEY_MAX_LENGTH) return null
  const parts = raw.split('+').map((p) => p.trim())
  const keyPart = parts.pop()
  if (!keyPart || parts.length === 0 || parts.some((p) => !p)) return null
  const mods: string[] = []
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()]
    if (!mod || mods.includes(mod)) return null
    mods.push(mod)
  }
  if (mods.length === 1 && mods[0] === 'Shift') return null
  const key = acceleratorKey(keyPart)
  return key ? [...mods, key].join('+') : null
}

export function parseGlobalHotkey(raw: unknown): string {
  return typeof raw === 'string' && toAccelerator(raw) ? raw.trim() : ''
}
