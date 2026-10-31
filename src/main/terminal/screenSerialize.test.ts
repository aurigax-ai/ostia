import { type IBuffer, type IBufferCell, type IBufferLine, Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import { serializeLogicalLines } from './screenSerialize'

function serialized(text: string): Promise<string[]> {
  const term = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
  return new Promise((resolve) => {
    term.write(text, () => {
      const buffer = term.buffer.normal
      resolve(serializeLogicalLines(buffer, 0, buffer.cursorY - 1))
      term.dispose()
    })
  })
}

describe('serializeLogicalLines', () => {
  it.each([
    ['trims trailing blanks of a plain line', 'plain text   \r\n', ['plain text']],
    [
      'keeps each style run and resets after it',
      '\x1b[31mred\x1b[0m mid \x1b[1;44mbold on blue\x1b[0m end\r\n',
      ['\x1b[0;31mred\x1b[0m mid \x1b[0;1;44mbold on blue\x1b[0m end'],
    ],
    [
      'writes RGB and 256-colour runs',
      '\x1b[38;2;10;20;30mrgb\x1b[48;5;200m bg  \x1b[0m\r\n',
      ['\x1b[0;38;2;10;20;30mrgb\x1b[0;38;2;10;20;30;48;5;200m bg  \x1b[0m'],
    ],
    [
      'keeps coloured blanks and drops the plain ones after them',
      'bg \x1b[42m    \x1b[0m    \r\n',
      ['bg \x1b[0;42m    \x1b[0m'],
    ],
    ['writes wide and combined characters once', '宽字 😀 e\u0301\r\n', ['宽字 😀 e\u0301']],
    [
      'keeps inverse blanks inside the run',
      '\x1b[7minv\x1b[0m\x1b[7m  \x1b[0m\r\n',
      ['\x1b[0;7minv  \x1b[0m'],
    ],
    [
      'joins a wrapped line into one logical line',
      `\x1b[32m${'g'.repeat(25)}\x1b[0m\r\n`,
      [`\x1b[0;32m${'g'.repeat(25)}\x1b[0m`],
    ],
    ['keeps latin-1 letters and a tab gap', 'caf\u00e9 \u00f1\tend\r\n', ['caf\u00e9 \u00f1  end']],
    ['fills skipped cells with spaces', 'ab\x1b[5Gcd\r\n', ['ab  cd']],
    [
      'keeps the style of each logical line when the next one starts with the same attributes',
      '\x1b[31mred\r\nsame\x1b[0m\r\n',
      ['\x1b[0;31mred\x1b[0m', '\x1b[0;31msame\x1b[0m'],
    ],
    [
      'changes style inside the second row of a wrapped line',
      `${'a'.repeat(20)}\x1b[1mbold\x1b[0m tail\r\n`,
      [`${'a'.repeat(20)}\x1b[0;1mbold\x1b[0m tail`],
    ],
    [
      'keeps a background left by erase-to-end and drops default blanks after it',
      '\x1b[44mfill\x1b[K\x1b[0m\r\n',
      [`\x1b[0;44mfill${' '.repeat(16)}\x1b[0m`],
    ],
    [
      'trims blanks that only carry a foreground colour',
      '\x1b[32mgreen\x1b[0m\x1b[33m   \x1b[0m\r\n',
      ['\x1b[0;32mgreen\x1b[0m'],
    ],
  ])('%s', async (_name, text, expected) => {
    expect(await serialized(text)).toEqual(expected)
  })
})

describe('serializeLogicalLines plain rows', () => {
  function written(text: string, run: (buffer: IBuffer) => string[]): Promise<string[]> {
    const term = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
    return new Promise((resolve) => {
      term.write(text, () => {
        resolve(run(term.buffer.normal))
        term.dispose()
      })
    })
  }

  function translateCalls(text: string): Promise<number> {
    return written(text, (buffer) => {
      const proto = Object.getPrototypeOf(
        (
          buffer as unknown as { _buffer: { lines: { get(row: number): object } } }
        )._buffer.lines.get(0),
      )
      const spy = vi.spyOn(proto, 'translateToString')
      serializeLogicalLines(buffer, 0, buffer.cursorY - 1)
      const calls = spy.mock.calls.length
      spy.mockRestore()
      return [String(calls)]
    }).then(([calls]) => Number(calls))
  }

  it('reads unstyled latin-1 rows straight from the cell words', async () => {
    expect(await translateCalls('plain\r\ncaf\u00e9 \u00f1\r\n')).toBe(0)
  })

  it.each([
    ['wide', '\u5b97\u5b57\r\n'],
    ['combined', 'e\u0301\r\n'],
  ])('falls back to the buffer for a %s row', async (_name, text) => {
    expect(await translateCalls(text)).toBeGreaterThan(0)
  })
})

const REFSGR_RESET = '\x1b[0m'

function refcolorParams(cell: IBufferCell, fg: boolean): number[] {
  const rgb = fg ? cell.isFgRGB() : cell.isBgRGB()
  const palette = fg ? cell.isFgPalette() : cell.isBgPalette()
  const color = fg ? cell.getFgColor() : cell.getBgColor()
  if (rgb) return [fg ? 38 : 48, 2, (color >> 16) & 255, (color >> 8) & 255, color & 255]
  if (!palette) return []
  if (color < 8) return [(fg ? 30 : 40) + color]
  if (color < 16) return [(fg ? 90 : 100) + color - 8]
  return [fg ? 38 : 48, 5, color]
}

function refcellStyle(cell: IBufferCell): string {
  if (cell.isAttributeDefault()) return ''
  const params = [0]
  if (cell.isBold()) params.push(1)
  if (cell.isDim()) params.push(2)
  if (cell.isItalic()) params.push(3)
  if (cell.isUnderline()) params.push(4)
  if (cell.isBlink()) params.push(5)
  if (cell.isInverse()) params.push(7)
  if (cell.isInvisible()) params.push(8)
  if (cell.isStrikethrough()) params.push(9)
  if (cell.isOverline()) params.push(53)
  params.push(...refcolorParams(cell, true), ...refcolorParams(cell, false))
  return `\x1b[${params.join(';')}m`
}

const REFSPACE = 32
const REFCELL_WORDS = 3
const REFCONTENT_MASK = 0x3fffff
const REFWIDTH_MASK = 0xc00000
const REFFG_INVERSE = 0x4000000
const REFBG_COLOR_MODE = 0x3000000

interface REFRowStyle {
  sgr: string
  fg: number
  bg: number
}

function refcellWords(line: IBufferLine): Uint32Array {
  return (line as unknown as { _line: { _data: Uint32Array } })._line._data
}

function refcontentEnd(words: Uint32Array, cols: number, blankStyles: boolean): number {
  for (let at = (cols - 1) * REFCELL_WORDS; at >= 0; at -= REFCELL_WORDS) {
    const content = words[at]
    if (!blankStyles) {
      const code = content & REFCONTENT_MASK
      if (code !== 0 && code !== REFSPACE) return at / REFCELL_WORDS + 1
      continue
    }
    const fg = words[at + 1]
    const bg = words[at + 2]
    if ((content | fg | bg) === 0) continue
    const code = content & REFCONTENT_MASK
    if ((code !== 0 && code !== REFSPACE) || bg & REFBG_COLOR_MODE || fg & REFFG_INVERSE) {
      return at / REFCELL_WORDS + 1
    }
  }
  return 0
}

function refserializeRow(
  line: IBufferLine,
  words: Uint32Array,
  stop: number,
  cell: IBufferCell,
  style: REFRowStyle,
  parts: string[],
): void {
  let runStart = 0
  for (let x = 0; x < stop; x++) {
    const at = x * REFCELL_WORDS
    if ((words[at] & REFWIDTH_MASK) === 0) continue
    const fg = words[at + 1]
    const bg = words[at + 2]
    if (fg === style.fg && bg === style.bg) continue
    style.fg = fg
    style.bg = bg
    line.getCell(x, cell)
    const next = refcellStyle(cell)
    if (next === style.sgr) continue
    if (x > runStart) parts.push(line.translateToString(false, runStart, x))
    parts.push(next || REFSGR_RESET)
    style.sgr = next
    runStart = x
  }
  if (stop > runStart) parts.push(line.translateToString(false, runStart, stop))
}

function referenceLogicalLines(
  buffer: IBuffer,
  start: number,
  end: number,
  blankStyles = true,
): string[] {
  const cell = buffer.getNullCell()
  const lines: string[] = []
  const style: REFRowStyle = { sgr: '', fg: 0, bg: 0 }
  let parts: string[] = []
  let line = buffer.getLine(start)
  for (let y = start; y <= end; y++) {
    const next = y < end ? buffer.getLine(y + 1) : undefined
    if (line) {
      if (y > start && !line.isWrapped) {
        if (style.sgr) parts.push(REFSGR_RESET)
        lines.push(parts.join(''))
        parts = []
        style.sgr = ''
        style.fg = 0
        style.bg = 0
      }
      const words = refcellWords(line)
      const stop =
        next?.isWrapped === true ? line.length : refcontentEnd(words, line.length, blankStyles)
      refserializeRow(line, words, stop, cell, style, parts)
    }
    line = next
  }
  if (style.sgr) parts.push(REFSGR_RESET)
  lines.push(parts.join(''))
  return lines
}

const FUZZ_CHARS = [
  'a',
  'b',
  ' ',
  'x',
  '\u00e9',
  '\u00ff',
  '\u0080',
  '\u00a0',
  '\u0100',
  '\u5b57',
  '\u{1F600}',
  'e\u0301',
  '\t',
]
const FUZZ_SGR = [
  '\x1b[0m',
  '\x1b[1m',
  '\x1b[2m',
  '\x1b[3m',
  '\x1b[4m',
  '\x1b[4:3m',
  '\x1b[7m',
  '\x1b[9m',
  '\x1b[53m',
  '\x1b[31m',
  '\x1b[92m',
  '\x1b[42m',
  '\x1b[38;5;200m',
  '\x1b[48;5;17m',
  '\x1b[38;2;1;2;3m',
  '\x1b[48;2;9;8;7m',
  '\x1b[39m',
  '\x1b[49m',
  '\x1b]8;;http://x\x07',
  '\x1b]8;;\x07',
]
const FUZZ_EDITS = ['\x1b[K', '\x1b[5G', '\x1b[2X', '\x1b[1P', '\x1b[2@', '\r\n', '\r\n']

function fuzzInput(next: (n: number) => number, styled: boolean): string {
  let text = ''
  for (let i = 0, n = 20 + next(200); i < n; i++) {
    const kind = next(10)
    const pool = kind < 6 ? FUZZ_CHARS : kind < 9 && styled ? FUZZ_SGR : FUZZ_EDITS
    text += pool[next(pool.length)]
  }
  return `${text}\x1b[0m\r\n`
}

describe('serializeLogicalLines against the buffer API', () => {
  it('matches the reference on seeded random terminals', async () => {
    let seed = 20261019
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let round = 0; round < 400; round++) {
      const term = new Terminal({
        cols: 5 + next(30),
        rows: 8,
        scrollback: 200,
        allowProposedApi: true,
      })
      const text = fuzzInput(next, round % 2 === 0)
      await new Promise<void>((resolve) => term.write(text, resolve))
      if (next(4) === 0) term.resize(5 + next(30), 8)
      const buffer = term.buffer.normal
      const end = buffer.length - 1
      for (const blankStyles of [true, false]) {
        expect(serializeLogicalLines(buffer, 0, end, blankStyles), JSON.stringify(text)).toEqual(
          referenceLogicalLines(buffer, 0, end, blankStyles),
        )
      }
      term.dispose()
    }
  })
})
