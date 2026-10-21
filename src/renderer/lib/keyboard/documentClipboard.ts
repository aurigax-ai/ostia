import { isNativeClipboardKey, type KeyLike } from '@shared/keyboard/chordSpec'
import type { ClipboardEdit } from '@shared/keyboard/clipboardChords'
import { copyActivePaneSelection } from '@/lib/agents/selectionCopiers'
import { chordOf, matchChord, onBindingsChange } from './chords'
import { isRemappedEvent } from './modifierRemapEvents'

export interface FocusContext {
  editable: boolean
  hasSelection: boolean
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])

export function clipboardChordOf(e: KeyLike, mac: boolean): ClipboardEdit | null {
  const chord = matchChord(e, mac)
  if (chord !== 'copy' && chord !== 'paste') return null
  return mac && isNativeClipboardKey(e) && !isRemappedEvent(e) ? null : chord
}

export function documentEdit(edit: ClipboardEdit, focus: FocusContext): ClipboardEdit | null {
  if (focus.editable) return edit
  return edit === 'copy' && focus.hasSelection ? 'copy' : null
}

export function isEditableElement(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type)
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable === true || hasEditContext(el)
}

function hasEditContext(el: HTMLElement): boolean {
  return Boolean((el as HTMLElement & { editContext?: unknown }).editContext)
}

export function handleDocumentClipboardChord(e: KeyboardEvent, mac: boolean): boolean {
  if (e.defaultPrevented) return false
  const edit = clipboardChordOf(e, mac)
  if (!edit) return false
  e.preventDefault()
  if (edit === 'copy' && !isEditableElement(document.activeElement) && copyActivePaneSelection()) {
    return true
  }
  const plan = documentEdit(edit, {
    editable: isEditableElement(document.activeElement),
    hasSelection: Boolean(document.getSelection()?.toString()),
  })
  if (plan) void window.ostia.clipboard.edit(plan)
  return true
}

export function handleDocumentCopyEvent(e: ClipboardEvent): void {
  if (e.defaultPrevented || isEditableElement(document.activeElement)) return
  if (copyActivePaneSelection()) e.preventDefault()
}

export function syncClipboardChords(mac: boolean): () => void {
  const send = (): void =>
    window.ostia.clipboard.setChords({ copy: chordOf('copy', mac), paste: chordOf('paste', mac) })
  send()
  return onBindingsChange(send)
}
