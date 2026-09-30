export const HOVER_FOCUS_DELAY_MS = 150

const TEXT_ENTRY = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]'
const SURFACE_INPUTS = '.xterm-helper-textarea, .monaco-editor textarea'
const OVERLAYS =
  '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], [cmdk-root]'

function isTextEntry(el: Element | null): boolean {
  if (!el?.matches(TEXT_ENTRY)) return false
  return !el.matches(SURFACE_INPUTS)
}

export function canFocusOnHover(doc: Document): boolean {
  if (isTextEntry(doc.activeElement)) return false
  return doc.querySelector(OVERLAYS) === null
}
