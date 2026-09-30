import { readFileSync, statSync } from 'node:fs'
import type { FsBinaryResult } from '../shared/types'
import { resolveSafe } from './pathGuard'

export const FS_BINARY_MAX = 50 * 1024 * 1024

export function readBinaryConfined(
  path: unknown,
  roots: string[],
  max: number = FS_BINARY_MAX,
): FsBinaryResult {
  if (typeof path !== 'string') return { ok: false, error: 'denied' }
  const safe = resolveSafe(path, roots)
  if (safe === null) return { ok: false, error: 'denied' }
  try {
    const stat = statSync(safe)
    if (!stat.isFile()) return { ok: false, error: 'unreadable' }
    if (stat.size > max) return { ok: false, error: 'too-large', size: stat.size }
    const data = readFileSync(safe)
    if (data.byteLength > max) return { ok: false, error: 'too-large', size: data.byteLength }
    return { ok: true, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
  } catch {
    return { ok: false, error: 'unreadable' }
  }
}
