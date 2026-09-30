import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS } from '../plugins/builtin'
import type { Theme } from '../plugins/types'
import { contrastRatio } from './color'
import { applyTheme, effectiveThemeId, resolveTheme, themedTokens } from './theme'

const themes = BUILTIN_PLUGINS.flatMap((p) => p.contributes.themes ?? [])
const dark = themes.find((t) => t.id === 'adeberry') as Theme
const light = themes.find((t) => t.id === 'pine-light') as Theme

const choice = {
  followSystem: true,
  systemDark: true,
  theme: 'dracula',
  lightTheme: 'pine-light',
  darkTheme: 'adeberry',
}

describe('effectiveThemeId', () => {
  it('uses the single theme setting when follow-system is off, whatever the OS says', () => {
    expect(effectiveThemeId({ ...choice, followSystem: false, systemDark: false })).toBe('dracula')
    expect(effectiveThemeId({ ...choice, followSystem: false })).toBe('dracula')
  })

  it('picks the dark theme when the OS is dark and the light theme when it is light', () => {
    expect(effectiveThemeId(choice)).toBe('adeberry')
    expect(effectiveThemeId({ ...choice, systemDark: false })).toBe('pine-light')
  })
})

describe('resolveTheme', () => {
  it('falls back to the first theme for an unknown id', () => {
    expect(resolveTheme(themes, 'nope')).toBe(themes[0])
    expect(resolveTheme(themes, 'pine-light')).toBe(light)
  })
})

describe('themedTokens', () => {
  it('keeps the theme tokens without an accent or with an invalid one, adding only on-brand', () => {
    for (const accent of ['', 'not-a-color']) {
      const { 'on-brand': onBrand, ...rest } = themedTokens(dark, accent)
      expect(rest).toEqual(dark.tokens)
      expect(onBrand).toBe(dark.tokens.bg)
    }
  })

  it('puts dark text on a light accent and light text on a dark accent, on dark and light themes', () => {
    expect(themedTokens(dark, '#f2b347')['on-brand']).toBe(dark.tokens.bg)
    expect(themedTokens(dark, '#1f3a8a')['on-brand']).toBe(dark.tokens.bg)
    expect(themedTokens(light, '#1f3a8a')['on-brand']).toBe(light.tokens.bg)
    for (const theme of themes) {
      for (const accent of ['', '#f2b347', '#1f3a8a', '#ffffff', '#000000']) {
        const tokens = themedTokens(theme, accent)
        expect(
          contrastRatio(tokens['on-brand'], tokens.brand),
          `${theme.id} ${accent}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('overrides only the brand tokens for a valid accent', () => {
    const tokens = themedTokens(dark, '#ff8800')
    expect(tokens.brand).toBe('#ff8800')
    expect(tokens.bg).toBe(dark.tokens.bg)
    expect(tokens['brand-glow']).not.toBe(dark.tokens['brand-glow'])
  })
})

describe('applyTheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style')
    document.documentElement.removeAttribute('data-theme')
  })

  it('writes the tokens, the theme id and the color scheme onto the root element', () => {
    applyTheme(document.documentElement, light, '')
    const root = document.documentElement
    expect(root.style.getPropertyValue('--color-bg')).toBe(light.tokens.bg)
    expect(root.dataset.theme).toBe('pine-light')
    expect(root.style.colorScheme).toBe('light')
  })

  it('applies an accent and its readable on-brand color, and restores the theme brand when cleared', () => {
    const root = document.documentElement
    applyTheme(root, dark, '#ff8800')
    expect(root.style.getPropertyValue('--color-brand')).toBe('#ff8800')
    expect(root.style.getPropertyValue('--color-on-brand')).toBe(dark.tokens.bg)
    applyTheme(root, light, '#ff8800')
    expect(root.style.getPropertyValue('--color-on-brand')).toBe(light.tokens.bg)
    applyTheme(root, dark, '')
    expect(root.style.getPropertyValue('--color-brand')).toBe(dark.tokens.brand)
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('')
  })
})
