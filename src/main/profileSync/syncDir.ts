import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export function expandSyncDir(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const trimmed = raw.trim()
  const expanded =
    trimmed === '~'
      ? homedir()
      : trimmed.startsWith('~/')
        ? join(homedir(), trimmed.slice(2))
        : trimmed
  return isAbsolute(expanded) ? resolve(expanded) : null
}
