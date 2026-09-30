import { describe, expect, it } from 'vitest'
import {
  ACCENT_PRESETS,
  contrastRatio,
  deriveAccent,
  ensureContrast,
  luminance,
  normalizeHex,
} from './color'

describe('normalizeHex', () => {
  it('accepts #rgb and #rrggbb in any case and returns lowercase #rrggbb', () => {
    expect(normalizeHex('#F80')).toBe('#ff8800')
    expect(normalizeHex(' #00D8FF ')).toBe('#00d8ff')
  })

  it('rejects everything else', () => {
    for (const bad of [
      '',
      'ff8800',
      '#ff88',
      '#ff88000',
      '#gggggg',
      'red',
      'rgb(1,2,3)',
      5,
      null,
    ]) {
      expect(normalizeHex(bad), String(bad)).toBeNull()
    }
  })
})

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colors', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5)
    expect(luminance('#ffffff')).toBeCloseTo(1, 5)
  })
})

describe('ensureContrast', () => {
  it('keeps a color that already reads and darkens one that does not on a light background', () => {
    expect(ensureContrast('#0b62c4', '#f6f7f9')).toBe('#0b62c4')
    const adjusted = ensureContrast('#f2b347', '#f6f7f9')
    expect(adjusted).not.toBe('#f2b347')
    expect(contrastRatio(adjusted, '#f6f7f9')).toBeGreaterThanOrEqual(4.5)
  })

  it('lightens a color that is too dark on a dark background', () => {
    const adjusted = ensureContrast('#1a2b5c', '#1d2022')
    expect(contrastRatio(adjusted, '#1d2022')).toBeGreaterThanOrEqual(4.5)
  })
})

describe('deriveAccent', () => {
  it('derives brand, bright and glow tokens from the accent on a dark theme', () => {
    const { tokens, onBrand } = deriveAccent('#ff8800', 'dark', '#1d2022')
    expect(tokens.brand).toBe('#ff8800')
    expect(luminance(tokens['brand-bright'])).toBeGreaterThan(luminance(tokens.brand))
    expect(tokens['brand-glow']).toBe('rgba(255, 136, 0, 0.18)')
    expect(onBrand).toBe('#0b0d10')
  })

  it('makes the bright token darker on a light theme and picks readable text for the button', () => {
    const { tokens, onBrand } = deriveAccent('#0b62c4', 'light', '#f6f7f9')
    expect(luminance(tokens['brand-bright'])).toBeLessThan(luminance(tokens.brand))
    expect(onBrand).toBe('#ffffff')
  })

  it('gives every preset a readable brand and button text on both built-in backgrounds', () => {
    for (const preset of ACCENT_PRESETS) {
      for (const [appearance, bg] of [
        ['dark', '#1d2022'],
        ['light', '#f6f7f9'],
      ] as const) {
        const { tokens, onBrand } = deriveAccent(preset, appearance, bg)
        expect(contrastRatio(tokens.brand, bg), `${preset} ${appearance}`).toBeGreaterThanOrEqual(
          4.5,
        )
        expect(contrastRatio(onBrand, tokens.brand), `${preset} button`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
