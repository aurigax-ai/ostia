import { ghosttyModule } from './ghosttyEngine'
import { WINDOW_LINES } from './historyPages'
import type { OstiaTerminal, TerminalOptions } from './ostiaTerminal'

export interface LayerPane {
  term: OstiaTerminal
  el: HTMLElement
  dispose: () => void
}

const NO_LINKS = { activate: () => {}, hover: () => {}, leave: () => {} }

export function createLayerPane(
  parent: HTMLElement,
  size: { cols: number; rows: number },
  options: TerminalOptions,
): LayerPane | null {
  const ghostty = ghosttyModule()
  if (!ghostty) return null
  const el = document.createElement('div')
  el.className = 'history-pane'
  parent.appendChild(el)
  const term = ghostty.createGhosttyTerminal(
    { ...options, scrollback: WINDOW_LINES * 4, nativeScrollbar: false },
    false,
    NO_LINKS,
  ).term
  term.open(el)
  term.resize(size.cols, size.rows)
  term.attachCustomKeyEventHandler(() => false)
  return {
    term,
    el,
    dispose: () => {
      term.dispose()
      el.remove()
    },
  }
}
