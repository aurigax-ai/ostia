import { currentThemeId } from './legacyIds'

export const MATCH_OSTIA_THEME = 'match'

const ID_MAX = 80

export function parseThemeChoice(raw: unknown): string {
  if (typeof raw !== 'string') return MATCH_OSTIA_THEME
  const id = raw.trim()
  return id === '' || id.length > ID_MAX ? MATCH_OSTIA_THEME : currentThemeId(id)
}

export const isLinkedTheme = (choice: string): boolean => choice === MATCH_OSTIA_THEME
