import type { TerminalRenderer } from '@/lib/settings/terminalPaneSettings'
import { ghosttyModule } from './ghosttyEngine'
import { WINDOW_LINES } from './historyPages'
import type { OstiaTerminal, TerminalOptions } from './ostiaTerminal'
import { mountSizedReadOnlyTerminal, readOnlyCopyKey } from './readOnlyTerminal'

export interface LayerPane {
  term: OstiaTerminal
  el: HTMLElement
  dispose: () => void
}

const NO_LINKS = { activate: () => {}, hover: () => {}, leave: () => {} }

export function createLayerPane(
  engine: TerminalRenderer,
  parent: HTMLElement,
  size: { cols: number; rows: number },
  options: TerminalOptions,
  onKey: (e: KeyboardEvent) => void,
): LayerPane | null {
  const el = document.createElement('div')
  el.className = 'history-pane'
  parent.appendChild(el)
  const ghostty = engine === 'ghostty' ? ghosttyModule() : null
  if (engine === 'ghostty' && !ghostty) {
    el.remove()
    return null
  }
  if (ghostty) {
    const created = ghostty.createGhosttyTerminal(
      { ...options, scrollback: WINDOW_LINES * 4, nativeScrollbar: false },
      false,
      NO_LINKS,
    )
    const term = created.term
    term.open(el)
    term.resize(size.cols, size.rows)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return false
      if (readOnlyCopyKey(e, term.hasSelection())) {
        e.preventDefault()
        void navigator.clipboard.writeText(term.getSelection())
      } else onKey(e)
      return false
    })
    return {
      term,
      el,
      dispose: () => {
        term.dispose()
        el.remove()
      },
    }
  }
  const mounted = mountSizedReadOnlyTerminal(el, size, { scrollback: WINDOW_LINES * 4 }, onKey)
  return {
    term: mounted.term,
    el,
    dispose: () => {
      mounted.dispose()
      el.remove()
    },
  }
}
