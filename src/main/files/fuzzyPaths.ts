export interface FuzzyHit {
  path: string
  score: number
  positions: number[]
}

const SEPARATORS = new Set(['/', '\\', '_', '-', '.', ' '])
const NAME_ONLY_BONUS = 10

function isWordStart(path: string, i: number): boolean {
  if (i === 0) return true
  const prev = path[i - 1]
  if (SEPARATORS.has(prev)) return true
  return prev === prev.toLowerCase() && path[i] !== path[i].toLowerCase()
}

function scoreOf(path: string, positions: number[]): number {
  const base = path.lastIndexOf('/') + 1
  let score = 0
  positions.forEach((pos, i) => {
    score += 1
    if (i > 0 && positions[i - 1] === pos - 1) score += 5
    if (isWordStart(path, pos)) score += 8
    if (pos >= base) score += 2
  })
  if (positions[0] >= base) score += NAME_ONLY_BONUS
  const span = positions[positions.length - 1] - positions[0] + 1
  return score - (span - positions.length) * 0.2 - path.length * 0.01
}

function forward(lower: string, query: string): number[] | null {
  const positions: number[] = []
  let from = 0
  for (const ch of query) {
    const at = lower.indexOf(ch, from)
    if (at < 0) return null
    positions.push(at)
    from = at + 1
  }
  return positions
}

function backward(lower: string, query: string): number[] | null {
  const positions: number[] = []
  let from = lower.length - 1
  for (let q = query.length - 1; q >= 0; q--) {
    const at = lower.lastIndexOf(query[q], from)
    if (at < 0) return null
    positions.unshift(at)
    from = at - 1
  }
  return positions
}

export function fuzzyMatch(rawQuery: string, path: string): FuzzyHit | null {
  const query = rawQuery.toLowerCase().replace(/\s+/g, '')
  if (!query) return null
  const lower = path.toLowerCase()
  let best: FuzzyHit | null = null
  for (const positions of [backward(lower, query), forward(lower, query)]) {
    if (!positions) continue
    const score = scoreOf(path, positions)
    if (!best || score > best.score) best = { path, score, positions }
  }
  return best
}

export function rankFiles(query: string, paths: string[], limit: number): FuzzyHit[] {
  const hits: FuzzyHit[] = []
  for (const path of paths) {
    const hit = fuzzyMatch(query, path)
    if (hit) hits.push(hit)
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return hits.slice(0, limit)
}
