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

const FILE_NAME_TEXT = /^[^\n\r/\\]*[^\s./\\]\.[A-Za-z][A-Za-z0-9]{0,7}$/
const URL_TEXT = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/

export function isStubText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === '' || FILE_NAME_TEXT.test(trimmed) || URL_TEXT.test(trimmed)
}

export function keyPastePlan(
  text: string,
  editorShown: boolean,
  contents: ClipboardContents,
): 'text' | 'files' | 'program' | 'none' {
  if (editorShown) return text ? 'text' : 'none'
  if (contents.files.length > 0) return 'files'
  if (contents.image && isStubText(text)) return 'program'
  return text ? 'text' : 'none'
}

export function pasteEventReadsClipboard(editorShown: boolean, mac: boolean): boolean {
  return mac && !editorShown
}
