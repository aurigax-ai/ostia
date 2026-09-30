import { wcagContrast, wcagLuminance } from 'culori'
import { describe, expect, it } from 'vitest'
import { ACCENT_PRESETS, deriveAccent, ensureContrast, normalizeHex, readableOn } from './color'

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

describe('contrast', () => {
  it('is 21 for black on white and 1 for identical colors', () => {
    expect(wcagContrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(wcagContrast('#123456', '#123456')).toBeCloseTo(1, 5)
    expect(wcagLuminance('#ffffff')).toBeCloseTo(1, 5)
  })
})

describe('ensureContrast', () => {
  it('keeps a color that already reads and darkens one that does not on a light background', () => {
    expect(ensureContrast('#0b62c4', '#f6f7f9')).toBe('#0b62c4')
    const adjusted = ensureContrast('#f2b347', '#f6f7f9')
    expect(adjusted).not.toBe('#f2b347')
    expect(wcagContrast(adjusted, '#f6f7f9')).toBeGreaterThanOrEqual(4.5)
  })

  it('lightens a color that is too dark on a dark background', () => {
    const adjusted = ensureContrast('#1a2b5c', '#1d2022')
    expect(wcagContrast(adjusted, '#1d2022')).toBeGreaterThanOrEqual(4.5)
  })
})

describe('readableOn', () => {
  it('picks dark text for a light fill like #f2b347 and light text for a dark fill', () => {
    expect(readableOn('#f2b347', ['#1d2022', '#e3edf5'])).toBe('#1d2022')
    expect(readableOn('#1f3a8a', ['#1d2022', '#e3edf5'])).toBe('#e3edf5')
  })

  it('keeps the first preferred color that reads at 4.5:1', () => {
    expect(readableOn('#0b62c4', ['#f6f7f9', '#1c2127'])).toBe('#f6f7f9')
  })

  it('falls back to near-black or white when no preferred color reads', () => {
    expect(readableOn('#ffcc00', ['#ffffff', '#ffee88'])).toBe('#0b0d10')
    expect(readableOn('#5a2d82', ['#3a3a3a', 'not-a-color'])).toBe('#ffffff')
  })
})

describe('deriveAccent', () => {
  it('derives brand, bright and glow tokens from the accent on a dark theme', () => {
    const tokens = deriveAccent('#ff8800', 'dark', '#1d2022')
    expect(tokens.brand).toBe('#ff8800')
    expect(wcagLuminance(tokens['brand-bright'])).toBeGreaterThan(wcagLuminance(tokens.brand))
    expect(tokens['brand-glow']).toBe('rgba(255, 136, 0, 0.18)')
  })

  it('makes the bright token darker on a light theme', () => {
    const tokens = deriveAccent('#0b62c4', 'light', '#f6f7f9')
    expect(wcagLuminance(tokens['brand-bright'])).toBeLessThan(wcagLuminance(tokens.brand))
  })

  it('gives every preset a readable brand and button text on both built-in backgrounds', () => {
    for (const preset of ACCENT_PRESETS) {
      for (const [appearance, bg] of [
        ['dark', '#1d2022'],
        ['light', '#f6f7f9'],
      ] as const) {
        const tokens = deriveAccent(preset, appearance, bg)
        expect(wcagContrast(tokens.brand, bg), `${preset} ${appearance}`).toBeGreaterThanOrEqual(
          4.5,
        )
        const onBrand = readableOn(tokens.brand, [bg])
        expect(wcagContrast(onBrand, tokens.brand), `${preset} button`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
