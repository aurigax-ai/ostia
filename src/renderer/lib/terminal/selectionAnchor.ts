import { anchorWithin, type BarAnchor } from '@/lib/capture/barAnchor'
import { type OstiaTerminal, terminalScreen } from './ostiaTerminal'

export function terminalSelectionAnchor(term: OstiaTerminal, container: Element): BarAnchor | null {
  const range = term.getSelectionPosition()
  const screen = term.element ? terminalScreen(term.element) : null
  if (!range || !screen || term.cols <= 0 || term.rows <= 0) return null
  const box = screen.getBoundingClientRect()
  const cellWidth = box.width / term.cols
  const cellHeight = box.height / term.rows
  const { viewportY } = term.buffer.active
  const startRow = Math.max(0, range.start.y - 1 - viewportY)
  const endRow = Math.min(term.rows - 1, range.end.y - 1 - viewportY)
  return anchorWithin(container, {
    left: box.left + (range.start.x - 1) * cellWidth,
    top: box.top + startRow * cellHeight,
    bottom: box.top + (endRow + 1) * cellHeight,
  })
}
