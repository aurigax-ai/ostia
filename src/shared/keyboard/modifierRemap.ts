export const REMAP_KEYS = [
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
] as const

export type RemapKey = (typeof REMAP_KEYS)[number]

export const REMAP_TARGETS = ['control', 'option', 'command'] as const

export type RemapTarget = (typeof REMAP_TARGETS)[number]

export type ModifierRemap = Partial<Record<RemapKey, RemapTarget>>

export interface ModifierFlags {
  ctrl: boolean
  alt: boolean
  meta: boolean
}

export const REMAP_DEFAULTS: Readonly<Record<RemapKey, RemapTarget>> = {
  ControlLeft: 'control',
  ControlRight: 'control',
  AltLeft: 'option',
  AltRight: 'option',
  MetaLeft: 'command',
  MetaRight: 'command',
}

const FAMILIES: readonly (readonly [keyof ModifierFlags, readonly RemapKey[]])[] = [
  ['ctrl', ['ControlLeft', 'ControlRight']],
  ['alt', ['AltLeft', 'AltRight']],
  ['meta', ['MetaLeft', 'MetaRight']],
]

const TARGET_FLAG: Readonly<Record<RemapTarget, keyof ModifierFlags>> = {
  control: 'ctrl',
  option: 'alt',
  command: 'meta',
}

const TARGET_KEY: Readonly<Record<RemapTarget, string>> = {
  control: 'Control',
  option: 'Alt',
  command: 'Meta',
}

function isRemapKey(code: string): code is RemapKey {
  return (REMAP_KEYS as readonly string[]).includes(code)
}

export function parseModifierRemap(raw: unknown): ModifierRemap {
  const out: ModifierRemap = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const source = raw as Record<string, unknown>
  for (const key of REMAP_KEYS) {
    const target = source[key]
    if (!REMAP_TARGETS.includes(target as RemapTarget)) continue
    if (target !== REMAP_DEFAULTS[key]) out[key] = target as RemapTarget
  }
  return out
}

export function remapTarget(table: ModifierRemap, key: RemapKey): RemapTarget {
  return table[key] ?? REMAP_DEFAULTS[key]
}

export function isIdentityRemap(table: ModifierRemap): boolean {
  return REMAP_KEYS.every((key) => remapTarget(table, key) === REMAP_DEFAULTS[key])
}

export function trackModifierKey(down: Set<RemapKey>, code: string, pressed: boolean): void {
  if (!isRemapKey(code)) return
  if (pressed) down.add(code)
  else down.delete(code)
}

export function remappedFlags(
  table: ModifierRemap,
  down: ReadonlySet<RemapKey>,
  real: ModifierFlags,
): ModifierFlags {
  const out: ModifierFlags = { ctrl: false, alt: false, meta: false }
  for (const [flag, keys] of FAMILIES) {
    if (!real[flag]) continue
    const held = keys.filter((key) => down.has(key))
    if (held.length === 0) out[flag] = true
    for (const key of held) out[TARGET_FLAG[remapTarget(table, key)]] = true
  }
  return out
}

export function remappedModifierKey(table: ModifierRemap, code: string): string | null {
  return isRemapKey(code) ? TARGET_KEY[remapTarget(table, code)] : null
}

export function sameFlags(a: ModifierFlags, b: ModifierFlags): boolean {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.meta === b.meta
}
