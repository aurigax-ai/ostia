export const SPLIT_TAB_NAME_MAX = 60

function hasControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

export interface SplitTabPlacement {
  name: string
}

export function normalizeSplitTabName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name || name.length > SPLIT_TAB_NAME_MAX || hasControlCharacter(name)) return null
  return name
}
