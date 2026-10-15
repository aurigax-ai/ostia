import { describe, expect, it } from 'vitest'
import { type BufferLike, readBufferText, readCommandText } from './blockText'

const COLS = 10

function buffer(rows: Array<string | { text: string; wrapped: true }>): BufferLike {
  const lines = rows.map((r) => (typeof r === 'string' ? { text: r, wrapped: false } : r))
  return {
    getLine: (y) => {
      const l = lines[y]
      if (!l) return undefined
      return {
        isWrapped: l.wrapped,
        translateToString: (trimRight = false, start = 0, end = COLS) => {
          const cells = l.text.padEnd(COLS).slice(start, end)
          return trimRight ? cells.trimEnd() : cells
        },
      }
    },
  }
}

describe('readBufferText', () => {
  it('joins soft-wrapped rows into one logical line without inserting a newline', () => {
    const buf = buffer(['$ ls', 'abcdefghij', { text: 'klm', wrapped: true }, 'next', '$ '])

    expect(readBufferText(buf, { line: 1, col: 0 }, { line: 4, col: 0 })).toBe(
      'abcdefghijklm\nnext',
    )
  })

  it('keeps spaces that fall exactly on a wrap boundary', () => {
    const buf = buffer(['hello     ', { text: 'world', wrapped: true }])

    expect(readBufferText(buf, { line: 0, col: 0 }, { line: 2, col: 0 })).toBe('hello     world')
  })

  it('strips trailing whitespace per line and drops trailing blank lines', () => {
    const buf = buffer(['one   ', 'two', '', '   ', '$ '])

    expect(readBufferText(buf, { line: 0, col: 0 }, { line: 4, col: 0 })).toBe('one\ntwo')
  })

  it('reads the end row up to its column when output stops mid-line', () => {
    const buf = buffer(['out1', 'partial%  '])

    expect(readBufferText(buf, { line: 0, col: 0 }, { line: 1, col: 7 })).toBe('out1\npartial')
  })

  it('returns an empty string when a marker was trimmed away', () => {
    const buf = buffer(['x'])

    expect(readBufferText(buf, { line: -1, col: 0 }, { line: 1, col: 0 })).toBe('')
    expect(readBufferText(buf, { line: 0, col: 0 }, { line: -1, col: 0 })).toBe('')
  })
})

describe('readCommandText', () => {
  it('reads from the input column of the B mark up to the C mark', () => {
    const buf = buffer(['~ ❯ echo h', { text: 'i there', wrapped: true }, ''])

    expect(readCommandText(buf, { line: 0, col: 4 }, { line: 2, col: 0 })).toBe('echo hi there')
  })

  it('reads a command that ends on the C line itself', () => {
    const buf = buffer(['$ ls -la  '])

    expect(readCommandText(buf, { line: 0, col: 2 }, { line: 0, col: 8 })).toBe('ls -la')
  })
})
