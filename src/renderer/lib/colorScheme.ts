import { isLinkedTheme } from '@shared/themeChoice'
import { useMemo } from 'react'
import type { ColorScheme, Theme } from '../plugins/types'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { normalizeHex } from './color'
import { currentTheme, themedTokens, useEffectiveTheme } from './theme'

export type SchemeSurface = 'terminal' | 'editor'

export function schemeForTheme(schemes: ColorScheme[], theme: Theme | undefined): ColorScheme {
  const appearance = theme?.appearance ?? 'dark'
  return (
    schemes.find((s) => s.id === theme?.colorScheme) ??
    schemes.find((s) => s.appearance === appearance) ??
    schemes[0]
  )
}

export function resolveScheme(
  schemes: ColorScheme[],
  choice: string,
  theme: Theme | undefined,
): ColorScheme {
  const picked = isLinkedTheme(choice) ? undefined : schemes.find((s) => s.id === choice)
  return picked ?? schemeForTheme(schemes, theme)
}

export function accentScheme(
  scheme: ColorScheme,
  choice: string,
  theme: Theme | undefined,
  accent: string,
): ColorScheme {
  if (!theme || !isLinkedTheme(choice) || !normalizeHex(accent)) return scheme
  return { ...scheme, colors: { ...scheme.colors, cursor: themedTokens(theme, accent).brand } }
}

export function currentScheme(surface: SchemeSurface): ColorScheme {
  const settings = useSettingsStore.getState()
  const theme = currentTheme()
  const choice = settings[surface].theme
  const scheme = resolveScheme(usePluginsStore.getState().colorSchemes, choice, theme)
  return accentScheme(scheme, choice, theme, settings.appearance.accent)
}

export function useScheme(surface: SchemeSurface): ColorScheme {
  const schemes = usePluginsStore((s) => s.colorSchemes)
  const choice = useSettingsStore((s) => s[surface].theme)
  const accent = useSettingsStore((s) => s.appearance.accent)
  const theme = useEffectiveTheme()
  return useMemo(
    () => accentScheme(resolveScheme(schemes, choice, theme), choice, theme, accent),
    [schemes, choice, theme, accent],
  )
}
