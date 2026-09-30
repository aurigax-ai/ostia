export const MATCH_PINE_THEME = 'match'

const ID_MAX = 80

export function parseThemeChoice(raw: unknown): string {
  if (typeof raw !== 'string') return MATCH_PINE_THEME
  const id = raw.trim()
  return id === '' || id.length > ID_MAX ? MATCH_PINE_THEME : id
}

export const isLinkedTheme = (choice: string): boolean => choice === MATCH_PINE_THEME
