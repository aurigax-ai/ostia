import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
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
