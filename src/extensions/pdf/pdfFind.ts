export interface FindMatch {
  page: number
  nth: number
}

function fold(text: string, matchCase: boolean): string {
  return matchCase ? text : text.toLocaleLowerCase()
}

export function countIn(text: string, query: string, matchCase: boolean): number {
  if (!query) return 0
  const hay = fold(text, matchCase)
  const needle = fold(query, matchCase)
  let count = 0
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) count++
  return count
}

export function matchOffsets(text: string, query: string, matchCase: boolean): number[] {
  if (!query) return []
  const hay = fold(text, matchCase)
  const needle = fold(query, matchCase)
  const offsets: number[] = []
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    offsets.push(at)
  }
  return offsets
}

export function findMatches(
  pages: readonly (readonly string[] | undefined)[],
  query: string,
  matchCase: boolean,
): FindMatch[] {
  const matches: FindMatch[] = []
  pages.forEach((items, index) => {
    if (!items) return
    const total = items.reduce((sum, text) => sum + countIn(text, query, matchCase), 0)
    for (let nth = 0; nth < total; nth++) matches.push({ page: index + 1, nth })
  })
  return matches
}

export function firstMatchFrom(matches: readonly FindMatch[], page: number): number {
  const at = matches.findIndex((match) => match.page >= page)
  return at >= 0 ? at : matches.length > 0 ? 0 : -1
}

export function stepIndex(active: number, total: number, direction: 1 | -1): number {
  if (total === 0) return -1
  if (active < 0) return direction === 1 ? 0 : total - 1
  return (active + direction + total) % total
}

export function seedFromHash(hash: string): { page: number | null; find: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const page = Number.parseInt(params.get('page') ?? '', 10)
  return { page: Number.isInteger(page) && page > 0 ? page : null, find: params.get('find') ?? '' }
}
