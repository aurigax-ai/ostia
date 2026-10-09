import { TERMINAL_INPUT_SELECTOR } from './ostiaTerminal'

const MIDDLE_BUTTON = 1
const TERMINAL = '.terminal-surface'
const TERMINAL_INPUT = TERMINAL_INPUT_SELECTOR
const TEXT_TARGET =
  'input, textarea, .monaco-editor, [contenteditable]:not([contenteditable="false"])'

function pasteZone(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null
  return target.closest(TERMINAL) ?? target.closest(TEXT_TARGET)
}

export function routeMiddlePaste(e: MouseEvent, doc: Document): void {
  if (e.button !== MIDDLE_BUTTON || e.defaultPrevented) return
  const zone = pasteZone(e.target)
  const focused = doc.activeElement
  if (zone && focused && zone.contains(focused)) return
  const terminalInput = zone?.matches(TERMINAL)
    ? zone.querySelector<HTMLElement>(TERMINAL_INPUT)
    : null
  if (terminalInput) {
    terminalInput.focus()
    return
  }
  e.preventDefault()
}

export function installMiddlePasteGuard(win: Window): () => void {
  const onMouseUp = (e: MouseEvent): void => routeMiddlePaste(e, win.document)
  win.addEventListener('mouseup', onMouseUp, true)
  return () => win.removeEventListener('mouseup', onMouseUp, true)
}
