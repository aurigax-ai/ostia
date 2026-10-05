interface KeyLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export const KILL_LINE = '\x15'

export function macLineEditKey(e: KeyLike, mac: boolean): string | null {
  if (!mac || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  return e.key === 'Backspace' ? KILL_LINE : null
}
