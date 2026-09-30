import type { ClipboardKeys } from '../settings/terminalPaneSettings'

interface KeyLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export function smartClipboardAction(
  e: KeyLike,
  mode: ClipboardKeys,
  hasSelection: boolean,
  mac: boolean,
): 'copy' | 'paste' | null {
  if (mac || mode !== 'smart') return null
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return null
  const key = e.key.toLowerCase()
  if (key === 'c') return hasSelection ? 'copy' : null
  if (key === 'v') return 'paste'
  return null
}
