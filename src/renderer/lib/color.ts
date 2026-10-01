import {
  type Color,
  type Oklch,
  clampChroma,
  converter,
  differenceEuclidean,
  formatHex,
  formatRgb,
  interpolate,
  modeLrgb,
  modeOklab,
  modeOklch,
  modeRgb,
  parse,
  useMode,
  wcagContrast,
  wcagLuminance,
} from 'culori/fn'

useMode(modeRgb)
useMode(modeLrgb)
useMode(modeOklab)
useMode(modeOklch)

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const toRgb = converter('rgb')
const toOklch = converter('oklch')
const perceivedDistance = differenceEuclidean('oklab')

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

export const SELECTION_MIN_DISTANCE = 0.05
const PANEL_REACH = 0.2
const PANEL_STEP = 0.02
const NEUTRAL_CHROMA = 0.005
const SELECTION_HUE = 250
const SELECTION_MAX_CHROMA = 0.12
const SELECTION_MAX_SHIFT = 0.4
const SELECTION_STEP = 0.01

function overBackground(color: string, background: string): Color {
  const parsed = parse(color) ?? parse(background)
  const base = parse(background)
  if (!parsed || !base) return { mode: 'rgb', r: 0, g: 0, b: 0 }
  return interpolate([base, { ...parsed, alpha: 1 }], 'rgb')(parsed.alpha ?? 1)
}

function panelsNear(background: string): Color[] {
  const lightness = toOklch(parse(background) ?? '#000000')?.l ?? 0
  const panels: Color[] = [parse(background) ?? { mode: 'rgb', r: 0, g: 0, b: 0 }]
  for (let offset = -PANEL_REACH; offset <= PANEL_REACH + 1e-9; offset += PANEL_STEP) {
    const l = Math.min(1, Math.max(0, lightness + offset))
    panels.push({ mode: 'oklch', l, c: 0 })
  }
  return panels
}

export function selectionVisibility(selection: string, background: string): number {
  const selected = overBackground(selection, background)
  let worst = Number.POSITIVE_INFINITY
  for (const panel of panelsNear(background)) {
    const replaced = perceivedDistance(selected, panel)
    const blended = perceivedDistance(interpolate([panel, selected], 'rgb')(0.5), panel)
    worst = Math.min(worst, replaced, blended)
  }
  return worst
}

const visibleSelections = new Map<string, string>()

export function visibleSelection(selection: string, background: string): string {
  const key = `${selection}|${background}`
  const known = visibleSelections.get(key)
  if (known) return known
  const visible = findVisibleSelection(selection, background)
  visibleSelections.set(key, visible)
  return visible
}

function findVisibleSelection(selection: string, background: string): string {
  if (selectionVisibility(selection, background) >= SELECTION_MIN_DISTANCE) return selection
  const base = toOklch(overBackground(selection, background)) as Oklch
  const hue = base.c >= NEUTRAL_CHROMA && base.h !== undefined ? base.h : SELECTION_HUE
  const away = (toOklch(parse(background) ?? '#000000')?.l ?? 0) < 0.5 ? 1 : -1
  let candidate = selection
  for (let shift = 0; shift <= SELECTION_MAX_SHIFT + 1e-9; shift += SELECTION_STEP) {
    const l = Math.min(1, Math.max(0, base.l + away * shift))
    for (let c = base.c; c <= SELECTION_MAX_CHROMA + 1e-9; c += SELECTION_STEP) {
      candidate = formatHex(clampChroma({ mode: 'oklch', l, c, h: hue }, 'oklch'))
      if (selectionVisibility(candidate, background) >= SELECTION_MIN_DISTANCE) return candidate
    }
  }
  return candidate
}
