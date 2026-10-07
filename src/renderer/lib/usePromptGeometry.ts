import { isEqual } from 'es-toolkit'
import { type RefObject, useEffect, useState } from 'react'
import {
  type TerminalBufferLine as IBufferLine,
  type OstiaTerminal as Xterm,
  terminalScreen,
} from './ostiaTerminal'
import {
  type CellMetrics,
  type PromptPlacement,
  type PromptStyle,
  placePrompt,
  rightPromptStart,
} from './promptOverlay'

export interface PromptGeometry {
  placement: PromptPlacement
  metrics: CellMetrics
  rows: number
  cols: number
}

export function measureCells(host: HTMLElement, term: Xterm): CellMetrics | null {
  const screen = terminalScreen(host)
  const stack = host.parentElement
  if (!(screen instanceof HTMLElement) || !stack || term.rows <= 0 || term.cols <= 0) return null
  const rect = screen.getBoundingClientRect()
  const origin = stack.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  return {
    width: rect.width / term.cols,
    height: rect.height / term.rows,
    left: rect.left - origin.left,
    top: rect.top - origin.top,
  }
}

function lineCells(line: IBufferLine | undefined, cols: number): string[] {
  if (!line) return []
  const out: string[] = []
  for (let x = 0; x < cols; x++) out.push(line.getCell(x)?.getChars() ?? '')
  return out
}

function sameGeometry(a: PromptGeometry | null, b: PromptGeometry | null): boolean {
  return isEqual(a, b)
}

export function usePromptGeometry(
  termRef: RefObject<Xterm | null>,
  hostRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  shown: boolean,
  style: PromptStyle,
  sameLine: boolean,
): PromptGeometry | null {
  const [geo, setGeo] = useState<PromptGeometry | null>(null)

  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!enabled || !term || !host) {
      setGeo(null)
      return
    }
    if (!shown) return
    const recompute = (): void => {
      const metrics = measureCells(host, term)
      const buf = term.buffer.active
      const line = buf.baseY + buf.cursorY
      const inputCol = buf.cursorX
      if (!metrics || buf.type === 'alternate') {
        setGeo((prev) => (prev === null ? prev : null))
        return
      }
      const rightPromptCol = rightPromptStart(lineCells(buf.getLine(line), term.cols), inputCol)
      const placement = placePrompt({
        inputLine: line,
        inputCol,
        viewportY: buf.viewportY,
        rows: term.rows,
        cols: term.cols,
        rightPromptCol,
        style,
        sameLine,
      })
      const next = placement ? { placement, metrics, rows: term.rows, cols: term.cols } : null
      setGeo((prev) => (sameGeometry(prev, next) ? prev : next))
    }
    recompute()
    const resize = term.onResize(recompute)
    const render = term.onRender(recompute)
    const scroll = term.onScroll(recompute)
    return () => {
      resize.dispose()
      render.dispose()
      scroll.dispose()
    }
  }, [termRef, hostRef, enabled, shown, style, sameLine])

  return geo
}
