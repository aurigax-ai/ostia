import { hasControlCharacter } from '../common/hiddenText'

export const SPLIT_TAB_NAME_MAX = 60

export interface SplitTabPlacement {
  name: string
}

export function normalizeSplitTabName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name || name.length > SPLIT_TAB_NAME_MAX || hasControlCharacter(name)) return null
  return name
}
