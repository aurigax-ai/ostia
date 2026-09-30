const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!HEX.test(value)) return null
  const digits = value.slice(1).toLowerCase()
  const full = digits.length === 3 ? [...digits].map((c) => c + c).join('') : digits
  return `#${full}`
}

type Rgb = [number, number, number]

function channels(hex: string): Rgb {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export function mix(from: string, to: string, amount: number): string {
  const a = channels(from)
  const b = channels(to)
  return toHex(a.map((v, i) => v + (b[i] - v) * amount) as Rgb)
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function ensureContrast(hex: string, background: string, minimum = 4.5): string {
  const target = luminance(background) > 0.4 ? '#000000' : '#ffffff'
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(hex, target, step / 20)
    if (contrastRatio(candidate, background) >= minimum) return candidate
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
    if (hex && contrastRatio(hex, base) >= minimum) return hex
  }
  return contrastRatio(base, INK_DARK) >= contrastRatio(base, INK_LIGHT) ? INK_DARK : INK_LIGHT
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
