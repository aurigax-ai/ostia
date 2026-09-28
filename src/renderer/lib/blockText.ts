export interface BufferLineLike {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export interface BufferLike {
  getLine(y: number): BufferLineLike | undefined
}

export interface CellPos {
  line: number
  col: number
}

export function readBufferText(buf: BufferLike, from: CellPos, to: CellPos): string {
  if (from.line < 0 || to.line < 0) return ''
  const lastLine = to.col > 0 ? to.line : to.line - 1
  const logical: string[] = []
  for (let y = from.line; y <= lastLine; y++) {
    const line = buf.getLine(y)
    if (!line) break
    const startCol = y === from.line ? from.col : 0
    const endCol = y === to.line ? to.col : undefined
    const wrapsIntoNext = y < lastLine && buf.getLine(y + 1)?.isWrapped === true
    const segment = line.translateToString(!wrapsIntoNext, startCol, endCol)
    if (y !== from.line && line.isWrapped && logical.length > 0) {
      logical[logical.length - 1] += segment
    } else {
      logical.push(segment)
    }
  }
  const trimmed = logical.map((l) => l.trimEnd())
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return trimmed.join('\n')
}

export function readCommandText(buf: BufferLike, input: CellPos, start: CellPos): string {
  return readBufferText(buf, input, start).trim()
}
