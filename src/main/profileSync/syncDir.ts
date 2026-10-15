import { isAbsolute, resolve } from 'node:path'
import { expandHome } from '../platform/pathGuard'

export function expandSyncDir(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const trimmed = raw.trim()
  const expanded = expandHome(trimmed)
  return isAbsolute(expanded) ? resolve(expanded) : null
}
