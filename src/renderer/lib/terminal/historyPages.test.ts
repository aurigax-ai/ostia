import { describe, expect, it } from 'vitest'
import {
  earlierStart,
  laterStart,
  lineAtRow,
  logicalLinesFrom,
  PAGE_LINES,
  rowOfLine,
  WINDOW_LINES,
  windowStart,
} from './historyPages'

function rows(spec: (string | { wrapped: string })[]) {
  return {
    length: spec.length,
    getLine: (y: number) => {
      const row = spec[y]
      if (row === undefined) return undefined
      const text = typeof row === 'string' ? row : row.wrapped
      return { isWrapped: typeof row !== 'string', translateToString: () => text }
    },
  }
}

describe('history pages', () => {
  it('puts the target a page below the window top, inside the history', () => {
    expect(windowStart(10_000, 0, 50_000)).toBe(10_000 - PAGE_LINES)
    expect(windowStart(100, 0, 50_000)).toBe(0)
    expect(windowStart(49_990, 0, 50_000)).toBe(50_000 - WINDOW_LINES)
    expect(windowStart(500, 300, 1000)).toBe(300)
  })

  it('moves the window one page at a time without leaving the history', () => {
    expect(earlierStart(5000, 0)).toBe(5000 - PAGE_LINES)
    expect(earlierStart(1000, 900)).toBe(900)
    expect(laterStart(0, 0, 50_000)).toBe(PAGE_LINES)
    expect(laterStart(49_500, 0, 50_000)).toBe(50_000 - WINDOW_LINES)
  })

  it('maps rows and logical lines across soft wraps', () => {
    const buf = rows(['a', 'bb', { wrapped: 'bb' }, 'c', '', ''])
    expect(rowOfLine(buf, 0)).toBe(0)
    expect(rowOfLine(buf, 2)).toBe(3)
    expect(lineAtRow(buf, 2)).toBe(1)
    expect(lineAtRow(buf, 3)).toBe(2)
    expect(logicalLinesFrom(buf, 0)).toBe(3)
    expect(logicalLinesFrom(buf, 2)).toBe(1)
  })
})
