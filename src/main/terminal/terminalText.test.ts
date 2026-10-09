import { describe, expect, it } from 'vitest'
import { PromptMarkScanner, plainTerminalText } from './terminalText'

const C = '\x1b]133;C\x1b\\'
const D0 = '\x1b]133;D;0\x1b\\'

describe('plainTerminalText', () => {
  it('drops colours, cursor moves and OSC strings and keeps the text', () => {
    const raw =
      '\x1b[1;32mready\x1b[0m in \x1b]8;;http://x\x07link\x1b]8;;\x07 42ms\r\n\x1b[2Kdone\r\n'
    expect(plainTerminalText(raw)).toEqual({
      text: 'ready in link 42ms\ndone\n',
      consumed: raw.length,
    })
  })

  it('keeps only what a carriage return left on the line', () => {
    expect(plainTerminalText('10%\r50%\r100%\r\nok\r\n').text).toBe('100%\nok\n')
  })

  it('applies backspaces and drops other control characters', () => {
    expect(plainTerminalText('abx\bc\x07\tz\n').text).toBe('abc\tz\n')
  })

  it('stops before an escape sequence that is not complete yet', () => {
    expect(plainTerminalText('line\r\n\x1b[38;5')).toEqual({ text: 'line\n', consumed: 6 })
  })

  it('stops before a trailing carriage return whose newline may still come', () => {
    expect(plainTerminalText('half\r')).toEqual({ text: 'half', consumed: 4 })
  })
})

describe('PromptMarkScanner', () => {
  it('reports each OSC 133 mark with its position in the stream', () => {
    const data = `$ ls${C}out\r\n${D0}`
    const marks = new PromptMarkScanner().scan(data, 1000 + data.length)
    expect(marks).toEqual([
      { kind: 'C', arg: undefined, start: 1004, end: 1004 + C.length },
      { kind: 'D', arg: '0', start: 1004 + C.length + 5, end: 1000 + data.length },
    ])
  })

  it('accepts the BEL terminator', () => {
    expect(new PromptMarkScanner().scan('\x1b]133;D;130\x07', 12)).toEqual([
      { kind: 'D', arg: '130', start: 0, end: 12 },
    ])
  })

  it('finds a mark split across chunks exactly once', () => {
    const data = `ab${C}cd`
    for (let cut = 1; cut < data.length; cut++) {
      const scanner = new PromptMarkScanner()
      const marks = [
        ...scanner.scan(data.slice(0, cut), cut),
        ...scanner.scan(data.slice(cut), data.length),
      ]
      expect(marks).toEqual([{ kind: 'C', arg: undefined, start: 2, end: 2 + C.length }])
    }
  })

  it('ignores other OSC sequences', () => {
    expect(new PromptMarkScanner().scan('\x1b]7;file:///tmp\x07\x1b]633;E;ls\x07', 30)).toEqual([])
  })
})
