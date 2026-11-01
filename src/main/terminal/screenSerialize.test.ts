import { describe, expect, it } from 'vitest'
import { createHeadlessTerminal } from './ghosttyHeadless'
import { serializeLogicalLines } from './screenSerialize'

function serialized(text: string, cols = 20): string[] {
  const term = createHeadlessTerminal({ cols, rows: 6, scrollback: 100 })
  term.write(text)
  const buffer = term.buffer.normal
  const lines = serializeLogicalLines(buffer, 0, buffer.cursorY - 1)
  term.dispose()
  return lines
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


describe('serializeLogicalLines round trip', () => {
  function random(seed: number): () => number {
    let state = seed
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 2 ** 32
    }
  }

  function noise(seed: number): string {
    const next = random(seed)
    const words = ['alpha', 'beta', '\u5b97\u5b57', 'e\u0301', 'x', '   ', 'caf\u00e9']
    const styles = ['0', '1', '3', '4', '7', '31', '44', '92', '38;5;200', '48;2;9;8;7', '2', '9']
    let out = ''
    for (let i = 0; i < 80; i++) {
      const r = next()
      if (r < 0.3) out += `\x1b[${styles[Math.floor(next() * styles.length)]}m`
      else if (r < 0.35) out += '\r\n'
      else out += words[Math.floor(next() * words.length)]
    }
    return `${out}\x1b[0m\r\n`
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('serializes its own output unchanged (seed %i)', (seed) => {
    const first = serialized(noise(seed))
    const second = serialized(`${first.join('\r\n')}\r\n`)
    expect(second).toEqual(first)
  })
})
