import type { ClipboardKeys } from '@/settings/terminalPaneSettings'
import type { ClipboardContents } from '@shared/types'

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

export const PROGRAM_PASTE_KEY = '\x16'

export const NO_CLIPBOARD_CONTENTS: ClipboardContents = { files: [], image: false }

export function keyPastePlan(
  text: string,
  editorShown: boolean,
  contents: ClipboardContents,
): 'text' | 'files' | 'program' | 'none' {
  if (text) return 'text'
  if (editorShown) return 'none'
  if (contents.files.length > 0) return 'files'
  return contents.image ? 'program' : 'none'
}

export function pasteEventReadsClipboard(
  text: string,
  editorShown: boolean,
  mac: boolean,
): boolean {
  return mac && !text && !editorShown
}
