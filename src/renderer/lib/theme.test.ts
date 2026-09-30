import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS } from '../plugins/builtin'
import type { Theme } from '../plugins/types'
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
  it('returns the theme tokens untouched without an accent or with an invalid one', () => {
    expect(themedTokens(dark, '').tokens).toBe(dark.tokens)
    expect(themedTokens(dark, 'not-a-color').onBrand).toBeNull()
  })

  it('overrides only the brand tokens for a valid accent', () => {
    const { tokens } = themedTokens(dark, '#ff8800')
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

  it('applies an accent over the theme brand and removes it again when cleared', () => {
    const root = document.documentElement
    applyTheme(root, dark, '#ff8800')
    expect(root.style.getPropertyValue('--color-brand')).toBe('#ff8800')
    expect(root.style.getPropertyValue('--primary-foreground')).not.toBe('')
    applyTheme(root, dark, '')
    expect(root.style.getPropertyValue('--color-brand')).toBe(dark.tokens.brand)
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('')
  })
})
