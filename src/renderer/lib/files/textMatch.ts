import { escapeRegExp } from 'es-toolkit'

export interface MatchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export type LineMatcher = (line: string) => [number, number][]

export function textMatcher(query: string, options: MatchOptions): LineMatcher | null {
  if (!query) return null
  const body = options.regex ? query : escapeRegExp(query)
  const source = options.wholeWord ? `\\b(?:${body})\\b` : body
  let pattern: RegExp
  try {
    pattern = new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
  } catch {
    return null
  }
  return (line) => {
    const ranges: [number, number][] = []
    pattern.lastIndex = 0
    for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
      if (m[0].length === 0) {
        pattern.lastIndex++
        continue
      }
      ranges.push([m.index, m.index + m[0].length])
    }
    return ranges
  }
}
