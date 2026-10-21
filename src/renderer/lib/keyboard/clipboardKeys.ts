import type { ClipboardContents } from '@shared/app/appApi'
import type { ClipboardKeys } from '@/lib/settings/terminalPaneSettings'

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

export const CLIPBOARD_READ_MS = 300

const FILE_NAME_TEXT = /^[^\s/\\]+\.(png|jpe?g|gif|tiff?|heic|webp|pdf)$/i
const URL_TEXT = /^(https?|file):\/\/\S+$/i
const IMAGE_NAME_LINE = /^[^\r\n]*[^\s.]\.(png|jpe?g|gif|tiff?|heic|webp|pdf)$/i
const SHELL_OPERATOR = /[>|;&`]|\$\(/

export function isStubText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '' || FILE_NAME_TEXT.test(trimmed) || URL_TEXT.test(trimmed)) return true
  return IMAGE_NAME_LINE.test(trimmed) && !SHELL_OPERATOR.test(trimmed)
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

export function pasteEventReadsClipboard(
  types: readonly string[],
  text: string,
  editorShown: boolean,
  mac: boolean,
): boolean {
  if (!mac || editorShown) return false
  return !text || types.includes('Files') || types.includes('text/uri-list')
}

export function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}
