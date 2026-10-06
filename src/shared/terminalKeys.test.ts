import { describe, expect, it } from 'vitest'
import { parseChord } from './chordSpec'
import {
  checkSendChord,
  parseTerminalKeys,
  parseTerminalSend,
  sendChordProblem,
  sendData,
} from './terminalKeys'

const chord = (text: string) => {
  const spec = parseChord(text, true)
  if (!spec) throw new Error(`bad chord ${text}`)
  return spec
}

describe('sendData', () => {
  it('sends ESC and then the value for an escape sequence, like iTerm2', () => {
    expect(sendData({ type: 'escape', value: 'b' })).toBe('\x1bb')
    expect(sendData({ type: 'escape', value: '[1;5D' })).toBe('\x1b[1;5D')
  })

  it('sends one character per hex byte, with or without 0x, split by spaces or commas', () => {
    expect(sendData({ type: 'hex', value: '0x1b 0x7f' })).toBe('\x1b\x7f')
    expect(sendData({ type: 'hex', value: '0x5' })).toBe('\x05')
    expect(sendData({ type: 'hex', value: '1b,62' })).toBe('\x1bb')
    expect(sendData({ type: 'hex', value: ' 0x15 ' })).toBe('\x15')
  })

  it('refuses hex that is not a byte from 0x00 to 0x7f', () => {
    for (const value of ['', ' ', '0x80', '0xff', '0x100', 'zz', '0x', '0x1b0x7f']) {
      expect(sendData({ type: 'hex', value }), value).toBeNull()
    }
  })

  it('decodes \\n \\r \\t \\e \\\\ and \\xHH in text and sends the rest as typed', () => {
    expect(sendData({ type: 'text', value: 'clear\\r' })).toBe('clear\r')
    expect(sendData({ type: 'text', value: 'a\\tb\\nc' })).toBe('a\tb\nc')
    expect(sendData({ type: 'text', value: '\\e[A' })).toBe('\x1b[A')
    expect(sendData({ type: 'text', value: '\\x15' })).toBe('\x15')
    expect(sendData({ type: 'text', value: 'C:\\\\tmp' })).toBe('C:\\tmp')
    expect(sendData({ type: 'text', value: 'git status' })).toBe('git status')
  })

  it('refuses empty text, unknown escapes and \\x above 7f', () => {
    for (const value of ['', '\\', '\\q', '\\x8a', '\\x1', 'end\\']) {
      expect(sendData({ type: 'text', value }), value).toBeNull()
    }
  })

  it('refuses values longer than 1024 characters', () => {
    expect(sendData({ type: 'text', value: 'a'.repeat(1024) })).toHaveLength(1024)
    expect(sendData({ type: 'text', value: 'a'.repeat(1025) })).toBeNull()
    expect(sendData({ type: 'escape', value: 'a'.repeat(1025) })).toBeNull()
  })
})

describe('parseTerminalSend', () => {
  it('keeps a known type with a value that decodes and drops anything else', () => {
    const send = { type: 'hex', value: '0x01' }
    expect(parseTerminalSend(send)).toEqual(send)
    expect(parseTerminalSend({ ...send, extra: 1 })).toEqual(send)
    for (const raw of [
      null,
      'b',
      [],
      { type: 'macro', value: 'b' },
      { type: 'escape' },
      { type: 'escape', value: 3 },
      { type: 'hex', value: '0x80' },
    ]) {
      expect(parseTerminalSend(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe('sendChordProblem', () => {
  it('takes Option, Cmd and Ctrl chords, and single non-typing keys like Forward Delete', () => {
    for (const text of ['Alt+Left', 'Cmd+Backspace', 'Alt+Delete', 'Delete', 'Home', 'Shift+Tab']) {
      expect(sendChordProblem(chord(text)), text).toBeNull()
    }
    expect(checkSendChord('Ctrl+Shift+K', false)).toBeNull()
    expect(checkSendChord('PageUp', true)).toBeNull()
  })

  it('refuses keys that type, plain Escape, Tab and Enter, and the 1-9 range', () => {
    expect(sendChordProblem(chord('a'))).toBe('bare')
    expect(sendChordProblem(chord('Shift+a'))).toBe('bare')
    expect(sendChordProblem(chord('Space'))).toBe('bare')
    expect(sendChordProblem(chord('Enter'))).toBe('bare')
    expect(sendChordProblem(chord('Escape'))).toBe('escape')
    expect(sendChordProblem(chord('Tab'))).toBe('tab')
    expect(sendChordProblem(chord('Cmd+1-9'))).toBe('digit-range')
    expect(checkSendChord('Hyper+X', true)).toBe('invalid')
  })
})

describe('parseTerminalKeys', () => {
  it('keeps chords that parse with a valid send or null, trimmed, and drops the rest', () => {
    const parsed = parseTerminalKeys({
      ' Cmd+Delete ': { type: 'hex', value: '0x0b' },
      Delete: null,
      'Alt+Left': { type: 'escape', value: '' },
      'Cmd+Nope': { type: 'hex', value: '0x01' },
      '': null,
    })
    expect({ ...parsed }).toEqual({ 'Cmd+Delete': { type: 'hex', value: '0x0b' }, Delete: null })
  })

  it('returns an empty map for anything that is not an object', () => {
    for (const raw of [undefined, null, 'x', [{ type: 'hex', value: '0x01' }]]) {
      expect({ ...parseTerminalKeys(raw) }).toEqual({})
    }
  })
})
