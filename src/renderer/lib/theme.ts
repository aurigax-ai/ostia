import type { Theme } from '../plugins/types'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSystemThemeStore } from '../stores/systemThemeStore'
import { deriveAccent, normalizeHex } from './color'

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

export function themedTokens(
  theme: Theme,
  accent: string,
): { tokens: Record<string, string>; onBrand: string | null } {
  const hex = normalizeHex(accent)
  if (!hex) return { tokens: theme.tokens, onBrand: null }
  const derived = deriveAccent(hex, theme.appearance, theme.tokens.bg)
  return { tokens: { ...theme.tokens, ...derived.tokens }, onBrand: derived.onBrand }
}

export function applyTheme(root: HTMLElement, theme: Theme | undefined, accent: string): void {
  if (!theme) return
  const { tokens, onBrand } = themedTokens(theme, accent)
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(`--color-${k}`, v)
  root.dataset.theme = theme.id
  root.style.colorScheme = theme.appearance
  if (onBrand) root.style.setProperty('--primary-foreground', onBrand)
  else root.style.removeProperty('--primary-foreground')
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
