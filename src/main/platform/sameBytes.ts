import { timingSafeEqual } from 'node:crypto'

export function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
