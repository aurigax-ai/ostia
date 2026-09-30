import {
  converter,
  formatHex,
  formatRgb,
  interpolate,
  modeLrgb,
  modeRgb,
  useMode,
  wcagContrast,
  wcagLuminance,
} from 'culori/fn'

useMode(modeRgb)
useMode(modeLrgb)

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const toRgb = converter('rgb')

export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  return HEX.test(value) ? (formatHex(value) ?? null) : null
}

export function mix(from: string, to: string, amount: number): string {
  return formatHex(interpolate([from, to], 'rgb')(amount))
}

function withAlpha(hex: string, alpha: number): string {
  const rgb = toRgb(hex)
  return rgb ? formatRgb({ ...rgb, alpha }) : hex
}

export function ensureContrast(hex: string, background: string, minimum = 4.5): string {
  const target = wcagLuminance(background) > 0.4 ? '#000000' : '#ffffff'
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(hex, target, step / 20)
    if (wcagContrast(candidate, background) >= minimum) return candidate
  }
  return target
}

export interface AccentTokens {
  brand: string
  'brand-bright': string
  'brand-glow': string
}

const INK_DARK = '#0b0d10'
const INK_LIGHT = '#ffffff'

export function readableOn(fill: string, preferred: readonly string[], minimum = 4.5): string {
  const base = normalizeHex(fill)
  if (!base) return INK_DARK
  for (const candidate of preferred) {
    const hex = normalizeHex(candidate)
    if (hex && wcagContrast(hex, base) >= minimum) return hex
  }
  return wcagContrast(base, INK_DARK) >= wcagContrast(base, INK_LIGHT) ? INK_DARK : INK_LIGHT
}

export function deriveAccent(
  hex: string,
  appearance: 'dark' | 'light',
  background: string,
): AccentTokens {
  const brand = ensureContrast(hex, background)
  const dark = appearance === 'dark'
  const bright = mix(brand, dark ? '#ffffff' : '#000000', dark ? 0.35 : 0.3)
  return {
    brand,
    'brand-bright': bright,
    'brand-glow': withAlpha(brand, dark ? 0.18 : 0.14),
  }
}

export const ACCENT_PRESETS: readonly string[] = [
  '#00d8ff',
  '#61afef',
  '#bd93f9',
  '#ee5396',
  '#f2b347',
  '#58c98c',
]
