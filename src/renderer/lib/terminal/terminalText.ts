import type { OstiaTerminal } from './ostiaTerminal'
import { TERMINAL_INPUT_SELECTOR } from './ostiaTerminal'

const STREAM_MS = 50

export interface TerminalTextSource {
  term: OstiaTerminal
  displayed: () => OstiaTerminal
  onDisplay: (listener: () => void) => () => void
}

export interface TerminalText {
  region: HTMLElement
  setShown: (shown: boolean) => void
  review: () => void
  dispose: () => void
}

export function attachTerminalText(
  parent: HTMLElement,
  source: TerminalTextSource,
  label: string,
  shown: () => boolean,
): TerminalText {
  const { term } = source
  const region = document.createElement('div')
  region.className = 'terminal-text'
  region.setAttribute('role', 'log')
  region.setAttribute('aria-live', 'off')
  region.setAttribute('aria-label', label)
  region.tabIndex = -1
  parent.appendChild(region)

  const nodes: HTMLElement[] = []
  const texts: string[] = []
  let visible = shown()
  let committedAt = Number.NEGATIVE_INFINITY
  let timer = 0

  const focusInput = (): void => {
    parent.querySelector<HTMLElement>(TERMINAL_INPUT_SELECTOR)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    focusInput()
  }
  region.addEventListener('keydown', onKeyDown)

  const commit = (): void => {
    timer = 0
    if (!visible) return
    committedAt = performance.now()
    const shownTerm = source.displayed()
    const buffer = shownTerm.buffer.active
    const rows = shownTerm.rows
    while (nodes.length < rows) {
      const node = document.createElement('div')
      region.appendChild(node)
      nodes.push(node)
      texts.push('')
    }
    while (nodes.length > rows) {
      nodes.pop()?.remove()
      texts.pop()
    }
    region.dataset.cols = String(shownTerm.cols)
    region.dataset.rows = String(rows)
    const top = buffer.viewportY
    for (let y = 0; y < rows; y++) {
      const text = buffer.getLine(top + y)?.translateToString(true) ?? ''
      if (text === texts[y]) continue
      texts[y] = text
      nodes[y].textContent = text
    }
  }

  const schedule = (): void => {
    if (!visible || timer) return
    timer = window.setTimeout(commit, Math.max(0, committedAt + STREAM_MS - performance.now()))
  }

  const subscriptions = [
    term.onRender(schedule),
    term.onWriteParsed(schedule),
    term.onScroll(schedule),
    term.onResize(schedule),
    term.buffer.onBufferChange(schedule),
  ]
  const offDisplay = source.onDisplay(schedule)
  schedule()

  return {
    region,
    setShown: (next) => {
      visible = next
      if (!next) {
        window.clearTimeout(timer)
        timer = 0
      } else {
        schedule()
      }
    },
    review: () => region.focus(),
    dispose: () => {
      window.clearTimeout(timer)
      offDisplay()
      for (const sub of subscriptions) sub.dispose()
      region.removeEventListener('keydown', onKeyDown)
      region.remove()
    },
  }
}
