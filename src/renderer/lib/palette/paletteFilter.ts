import { defaultFilter } from 'cmdk'

const WORD_BREAK = /[\s.:_\-/…()]+/

function startsWords(value: string, search: string): boolean {
  const words = value.toLowerCase().split(WORD_BREAK).filter(Boolean)
  const tokens = search.toLowerCase().split(WORD_BREAK).filter(Boolean)
  return tokens.every((token) => words.some((word) => word.startsWith(token)))
}

export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const fuzzy = defaultFilter(value, search, keywords)
  if (fuzzy === 0) return 0
  return startsWords(value, search) ? 0.5 + fuzzy / 2 : fuzzy / 2
}
