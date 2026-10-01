import type { Theme } from '../plugins/types'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSystemThemeStore } from '../stores/systemThemeStore'
import { deriveAccent, normalizeHex, readableOn } from './color'

export interface ThemeChoice {
  followSystem: boolean
  systemDark: boolean
  theme: string
  lightTheme: string
  darkTheme: string
}

export function effectiveThemeId(choice: ThemeChoice): string {
  if (!choice.followSystem) return choice.theme
  return choice.systemDark ? choice.darkTheme : choice.lightTheme
}

export function resolveTheme(themes: Theme[], id: string): Theme | undefined {
  return themes.find((t) => t.id === id) ?? themes[0]
}

export const DEFAULT_LIGHT_THEME = 'pine-light'
export const DEFAULT_DARK_THEME = 'adeberry'

export function themedTokens(theme: Theme, accent: string): Record<string, string> {
  const hex = normalizeHex(accent)
  const tokens = hex
    ? { ...theme.tokens, ...deriveAccent(hex, theme.appearance, theme.tokens.bg) }
    : theme.tokens
  return {
    ...tokens,
    'on-brand': readableOn(tokens.brand, [tokens.bg, tokens.fg]),
    'on-attn': readableOn(tokens.attn, [tokens.fg, tokens.bg]),
  }
}

export function applyTheme(root: HTMLElement, theme: Theme | undefined, accent: string): void {
  if (!theme) return
  for (const [k, v] of Object.entries(themedTokens(theme, accent))) {
    root.style.setProperty(`--color-${k}`, v)
  }
  root.dataset.theme = theme.id
  root.style.colorScheme = theme.appearance
  root.classList.toggle('dark', theme.appearance === 'dark')
}

export const useSystemDark = (): boolean => useSystemThemeStore((s) => s.dark)

const systemDarkNow = (): boolean => useSystemThemeStore.getState().dark

export function currentTheme(): Theme | undefined {
  const { appearance } = useSettingsStore.getState()
  return resolveTheme(
    usePluginsStore.getState().themes,
    effectiveThemeId({ ...appearance, systemDark: systemDarkNow() }),
  )
}

export function useEffectiveTheme(): Theme | undefined {
  const followSystem = useSettingsStore((s) => s.appearance.followSystem)
  const theme = useSettingsStore((s) => s.appearance.theme)
  const lightTheme = useSettingsStore((s) => s.appearance.lightTheme)
  const darkTheme = useSettingsStore((s) => s.appearance.darkTheme)
  const themes = usePluginsStore((s) => s.themes)
  const systemDark = useSystemDark()
  return resolveTheme(
    themes,
    effectiveThemeId({ followSystem, systemDark, theme, lightTheme, darkTheme }),
  )
}
