import { wcagContrast } from 'culori'
import { describe, expect, it } from 'vitest'
import { normalizeHex } from '../lib/color'
import { BUILTIN_PLUGINS } from './builtin'
import { BUILTIN_COLOR_SCHEMES } from './colorSchemes'
import { ANSI_NAMES } from './types'

const REQUIRED = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground']
const RGBA = /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0|1|0?\.\d+)\)$/

describe('BUILTIN_COLOR_SCHEMES', () => {
  it('has unique ids and names', () => {
    const ids = BUILTIN_COLOR_SCHEMES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const names = BUILTIN_COLOR_SCHEMES.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every scheme all 16 ANSI colors and the required keys as #rrggbb', () => {
    for (const { id, colors } of BUILTIN_COLOR_SCHEMES) {
      for (const key of [...ANSI_NAMES, ...REQUIRED]) {
        const value = (colors as Record<string, string>)[key]
        expect(value, `${id}.${key}`).toBeTypeOf('string')
        if (key === 'selectionBackground' && RGBA.test(value)) continue
        expect(normalizeHex(value), `${id}.${key}`).toBe(value)
      }
    }
  })

  it('keeps the foreground at 4.5:1 or better on the background', () => {
    for (const { id, colors } of BUILTIN_COLOR_SCHEMES) {
      expect(wcagContrast(colors.foreground, colors.background), id).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('labels each scheme light or dark by its background', () => {
    for (const { id, appearance, colors } of BUILTIN_COLOR_SCHEMES) {
      const lightText = wcagContrast(colors.background, '#000000') > 10
      expect(appearance, id).toBe(lightText ? 'light' : 'dark')
    }
  })

  it('bundles a scheme of the same appearance with every built-in Ostia theme', () => {
    const themes = BUILTIN_PLUGINS.flatMap((p) => p.contributes.themes ?? [])
    for (const theme of themes) {
      const scheme = BUILTIN_COLOR_SCHEMES.find((s) => s.id === theme.colorScheme)
      expect(scheme, theme.id).toBeDefined()
      expect(scheme?.appearance, theme.id).toBe(theme.appearance)
    }
  })

  it('ships the catalog through the ostia.themes plugin', () => {
    const plugin = BUILTIN_PLUGINS.find((p) => p.id === 'ostia.themes')
    expect(plugin?.contributes.colorSchemes).toBe(BUILTIN_COLOR_SCHEMES)
    expect(BUILTIN_COLOR_SCHEMES.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'catppuccin-mocha',
        'catppuccin-latte',
        'tokyo-night',
        'gruvbox-dark',
        'gruvbox-light',
        'nord',
        'solarized-dark',
        'solarized-light',
        'rose-pine',
        'kanagawa-wave',
        'everforest-dark',
        'github-dark',
        'github-light',
        'monokai-classic',
      ]),
    )
  })

  it('keeps the Adeberry palette sampled from Warp, with its signature cyan cursor', () => {
    const adeberry = BUILTIN_COLOR_SCHEMES.find((s) => s.id === 'adeberry')
    expect(adeberry?.colors.background).toBe('#1d2022')
    expect(adeberry?.colors.cursor).toBe('#00d8ff')
    expect(adeberry?.colors.brightBlue).toBe(adeberry?.colors.cyan)
  })
})
