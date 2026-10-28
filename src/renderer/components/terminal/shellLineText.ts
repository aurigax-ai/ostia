import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'

export function shellLineHoldsText(
  term: OstiaTerminal,
  from: { line: number; col: number },
): boolean {
  const buf = term.buffer.active
  const endLine = buf.baseY + buf.cursorY
  for (let y = from.line; y <= endLine; y++) {
    const line = buf.getLine(y)
    if (!line || (y > from.line && !line.isWrapped)) return false
    const start = y === from.line ? from.col : 0
    const end = y === endLine ? buf.cursorX : term.cols
    for (let x = start; x < end; x++) {
      if ((line.getCell(x)?.getChars() ?? '').trim() !== '') return true
    }
  }
  return false
}
