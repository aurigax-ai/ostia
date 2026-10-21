export type ByteRange =
  | { kind: 'none' }
  | { kind: 'unsatisfiable' }
  | { kind: 'range'; start: number; end: number }

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/

export function parseByteRange(header: string | null, size: number): ByteRange {
  const match = header === null ? null : SINGLE_RANGE.exec(header.trim())
  if (!match) return { kind: 'none' }
  const [, first, last] = match
  if (first === '' && last === '') return { kind: 'none' }
  if (first === '') {
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix)) return { kind: 'none' }
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  const end = last === '' ? Infinity : Number(last)
  if (!Number.isSafeInteger(start) || Number.isNaN(end) || end < start) return { kind: 'none' }
  if (start >= size) return { kind: 'unsatisfiable' }
  return { kind: 'range', start, end: Math.min(end, size - 1) }
}
