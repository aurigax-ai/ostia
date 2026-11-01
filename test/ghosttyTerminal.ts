import {
  createGhosttyTerminal,
  type GhosttyTerminal,
  loadGhosttyEngine,
} from '@/lib/terminal/ghosttyTerminal'
import type { OstiaTerminal, TerminalOptions } from '@/lib/terminal/ostiaTerminal'

const NO_LINKS = { activate: () => {}, hover: () => {}, leave: () => {} }

function stubContext(canvas: HTMLCanvasElement): unknown {
  const noop = () => {}
  return new Proxy(
    { canvas, measureText: (text: string) => ({ width: text.length * 8 }) },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : noop) },
  )
}

export function stubCanvas(): () => void {
  const real = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function getContext(
    this: HTMLCanvasElement,
    kind: string,
  ) {
    return kind === '2d' ? stubContext(this) : null
  } as typeof HTMLCanvasElement.prototype.getContext
  return () => {
    HTMLCanvasElement.prototype.getContext = real
  }
}

export async function openGhostty(
  size: { cols: number; rows: number },
  options: TerminalOptions = {},
): Promise<OstiaTerminal> {
  await loadGhosttyEngine()
  const created: GhosttyTerminal = createGhosttyTerminal(
    { fontSize: 13, scrollback: 1000, smoothScrollDuration: 0, ...options },
    false,
    NO_LINKS,
  )
  created.term.open(document.createElement('div'))
  created.term.resize(size.cols, size.rows)
  return created.term
}
