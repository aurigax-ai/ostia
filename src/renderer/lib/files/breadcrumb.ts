export interface Crumb {
  key: string
  label: string
}

export const FOLDED_CRUMB = '…'

function segmentCrumbs(rest: string, base: string): Crumb[] {
  const parts = rest.split('/').filter(Boolean)
  return parts.map((label, i) => ({ key: `${base}/${parts.slice(0, i + 1).join('/')}`, label }))
}

export function crumbsOf(path: string, home: string | null): Crumb[] {
  const trimmedHome = home && home !== '/' ? home.replace(/\/+$/, '') : null
  if (path === '~' || path.startsWith('~/')) {
    return [{ key: '~', label: '~' }, ...segmentCrumbs(path.slice(1), '~')]
  }
  if (trimmedHome && (path === trimmedHome || path.startsWith(`${trimmedHome}/`))) {
    return [{ key: '~', label: '~' }, ...segmentCrumbs(path.slice(trimmedHome.length), '~')]
  }
  const crumbs = segmentCrumbs(path, '')
  return crumbs.length > 0 ? crumbs : [{ key: '/', label: '/' }]
}

export function shortName(name: string): string {
  const chars = Array.from(name)
  return (name.startsWith('.') ? chars.slice(0, 2) : chars.slice(0, 1)).join('')
}

export function maxFitLevel(crumbs: readonly Crumb[]): number {
  return crumbs.length
}

export function fitCrumbs(crumbs: readonly Crumb[], level: number): Crumb[] {
  if (level <= 0 || crumbs.length <= 1) return [...crumbs]
  const last = crumbs[crumbs.length - 1]
  const short = crumbs.slice(0, -1).map((c) => ({ key: c.key, label: shortName(c.label) }))
  const folded = Math.min(level - 1, short.length)
  if (folded === 0) return [...short, last]
  return [{ key: FOLDED_CRUMB, label: FOLDED_CRUMB }, ...short.slice(folded), last]
}
