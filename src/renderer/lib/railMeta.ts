export const PATH_ELLIPSIS = '…'

function splitPath(path: string): { head: string; segments: string[] } {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  const parts = trimmed.split('/')
  const head = parts[0] ?? ''
  return { head, segments: parts.slice(1).filter((part) => part !== '') }
}

export function pathCandidates(path: string): string[] {
  const { head, segments } = splitPath(path)
  const out = [path]
  if (segments.length < 2) return out
  for (let keep = segments.length - 1; keep >= 1; keep--) {
    out.push([head, PATH_ELLIPSIS, ...segments.slice(-keep)].join('/'))
  }
  out.push(segments[segments.length - 1] as string)
  return out.filter((candidate, i) => i === 0 || candidate.length < path.length)
}

export function shortenPath(path: string, maxChars: number): string {
  const candidates = pathCandidates(path)
  return (
    candidates.find((candidate) => candidate.length <= maxChars) ??
    (candidates[candidates.length - 1] as string)
  )
}

export interface FitInput {
  widths: readonly number[]
  available: number
  gap: number
  moreWidth: number
}

export function fitCount({ widths, available, gap, moreWidth }: FitInput): number {
  const total = widths.reduce((sum, w, i) => sum + w + (i > 0 ? gap : 0), 0)
  if (total <= available) return widths.length
  let used = moreWidth
  let count = 0
  for (const width of widths) {
    const next = used + gap + width
    if (next > available) break
    used = next
    count += 1
  }
  return Math.max(1, count)
}
