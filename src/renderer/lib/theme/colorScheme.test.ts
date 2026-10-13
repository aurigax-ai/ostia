import { BUILTIN_PLUGINS } from '@/plugins/builtin'
import type { ColorScheme, Theme } from '@/plugins/types'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useSystemThemeStore } from '@/stores/app/systemThemeStore'
import { usePluginsStore } from '@/stores/extensions/pluginsStore'
import { afterEach, describe, expect, it } from 'vitest'
import { SELECTION_MIN_DISTANCE, selectionVisibility } from './color'
import {
  accentScheme,
  currentScheme,
  resolveScheme,
  schemeForTheme,
  terminalTheme,
} from './colorScheme'
import { effectiveThemeId, resolveTheme } from './theme'

const themes = BUILTIN_PLUGINS.flatMap((p) => p.contributes.themes ?? [])
const schemes = BUILTIN_PLUGINS.flatMap((p) => p.contributes.colorSchemes ?? [])
const theme = (id: string): Theme => themes.find((t) => t.id === id) as Theme
const scheme = (id: string): ColorScheme => schemes.find((s) => s.id === id) as ColorScheme

describe('schemeForTheme', () => {
  it('returns the scheme each built-in theme names', () => {
    for (const t of themes) expect(schemeForTheme(schemes, t).id).toBe(t.colorScheme)
  })

  it('falls back to the first scheme of the same appearance for a theme naming an unknown scheme', () => {
    const plugin: Theme = { ...theme('ostia-light'), id: 'paper', colorScheme: 'missing' }
    expect(schemeForTheme(schemes, plugin).appearance).toBe('light')
    expect(schemeForTheme(schemes, { ...plugin, appearance: 'dark' }).appearance).toBe('dark')
  })
})

describe('resolveScheme', () => {
  it('follows the Ostia theme while linked', () => {
    expect(resolveScheme(schemes, 'match', theme('dracula'))).toBe(scheme('dracula'))
    expect(resolveScheme(schemes, 'match', theme('ostia-light'))).toBe(scheme('ostia-light'))
  })

  it('keeps an unlinked pick whatever the Ostia theme is', () => {
    for (const t of themes) {
      expect(resolveScheme(schemes, 'catppuccin-mocha', t)).toBe(scheme('catppuccin-mocha'))
    }
  })

  it('falls back to the Ostia theme scheme for an unknown id', () => {
    expect(resolveScheme(schemes, 'no-such-scheme', theme('oxocarbon'))).toBe(scheme('oxocarbon'))
  })

  it('follows the OS light/dark switch only while linked', () => {
    const choice = {
      followSystem: true,
      theme: 'adeberry',
      lightTheme: 'ostia-light',
      darkTheme: 'dracula',
    }
    const resolved = (systemDark: boolean, pick: string) =>
      resolveScheme(
        schemes,
        pick,
        resolveTheme(themes, effectiveThemeId({ ...choice, systemDark })),
      ).id
    expect(resolved(true, 'match')).toBe('dracula')
    expect(resolved(false, 'match')).toBe('ostia-light')
    expect(resolved(true, 'nord')).toBe('nord')
    expect(resolved(false, 'nord')).toBe('nord')
  })
})

describe('terminalTheme', () => {
  it('returns the colors untouched when the selection already stands out', () => {
    const mocha = scheme('catppuccin-mocha').colors
    expect(terminalTheme(mocha)).toBe(mocha)
  })

  it('replaces only a selection that would vanish over painted cells', () => {
    const oxocarbon = scheme('oxocarbon').colors
    const theme = terminalTheme(oxocarbon)
    expect(theme.selectionBackground).not.toBe(oxocarbon.selectionBackground)
    expect({ ...theme, selectionBackground: oxocarbon.selectionBackground }).toEqual(oxocarbon)
  })

  it('gives every built-in scheme a selection visible over nearby painted panels', () => {
    for (const s of schemes) {
      const { selectionBackground, background } = terminalTheme(s.colors)
      expect(selectionVisibility(selectionBackground, background), s.id).toBeGreaterThanOrEqual(
        SELECTION_MIN_DISTANCE,
      )
    }
  })
})

describe('accentScheme', () => {
  it('gives a linked scheme the accent as its cursor color', () => {
    const linked = accentScheme(scheme('adeberry'), 'match', theme('adeberry'), '#f2b347')
    expect(linked.colors.cursor).toBe('#f2b347')
    expect(linked.colors.background).toBe(scheme('adeberry').colors.background)
  })

  it('leaves an unlinked pick, or a scheme without an accent, untouched', () => {
    const mocha = scheme('catppuccin-mocha')
    expect(accentScheme(mocha, 'catppuccin-mocha', theme('adeberry'), '#f2b347')).toBe(mocha)
    expect(accentScheme(mocha, 'match', theme('adeberry'), '')).toBe(mocha)
  })
})

describe('currentScheme', () => {
  const settingsInit = useSettingsStore.getState()
  const pluginsInit = usePluginsStore.getState()
  const systemInit = useSystemThemeStore.getState()

  afterEach(() => {
    useSettingsStore.setState(settingsInit, true)
    usePluginsStore.setState(pluginsInit, true)
    useSystemThemeStore.setState(systemInit, true)
  })

  it('resolves the terminal and editor axes independently from the settings', () => {
    useSettingsStore.setState((s) => ({
      appearance: { ...s.appearance, theme: 'one-dark-vivid', followSystem: false },
      terminal: { ...s.terminal, theme: 'gruvbox-dark' },
      editor: { ...s.editor, theme: 'match' },
    }))
    expect(currentScheme('terminal').id).toBe('gruvbox-dark')
    expect(currentScheme('editor').id).toBe('one-dark-vivid')
  })

  it('an unlinked terminal theme changes the terminal colors while the ostia theme stays', () => {
    useSettingsStore.setState((s) => ({
      appearance: { ...s.appearance, theme: 'adeberry', followSystem: false },
      terminal: { ...s.terminal, theme: 'match' },
      editor: { ...s.editor, theme: 'match' },
    }))
    expect(currentScheme('terminal').colors.background).toBe('#1d2022')
    useSettingsStore.setState((s) => ({
      terminal: { ...s.terminal, theme: 'catppuccin-mocha' },
    }))
    expect(currentScheme('terminal').colors.background).toBe('#1e1e2e')
    expect(currentScheme('terminal').id).toBe('catppuccin-mocha')
    expect(currentScheme('editor').id).toBe('adeberry')
  })
})
