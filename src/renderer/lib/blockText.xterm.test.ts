import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { readBufferText, readCommandText } from './blockText'

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

describe('readBufferText on a real xterm buffer', () => {
  it('reads a soft-wrapped command and its output between OSC 133 positions', async () => {
    const term = new Terminal({ cols: 20, rows: 10, allowProposedApi: true })
    const buf = () => term.buffer.active
    const marks: Record<string, { line: number; col: number }> = {}
    term.parser.registerOscHandler(133, (data) => {
      marks[data[0]] = { line: buf().baseY + buf().cursorY, col: buf().cursorX }
      return true
    })

    const command = `echo ${'y'.repeat(20)}`
    await write(term, '\x1b]133;A\x07$ \x1b]133;B\x07')
    await write(term, `${command}\r\n\x1b]133;C\x07`)
    await write(term, `${'z'.repeat(25)}\r\nlast   \r\n\x1b]133;D;0\x07`)

    expect(buf().getLine(marks.B.line + 1)?.isWrapped).toBe(true)
    expect(readCommandText(buf(), marks.B, marks.C)).toBe(command)
    expect(readBufferText(buf(), { line: marks.C.line, col: 0 }, marks.D)).toBe(
      `${'z'.repeat(25)}\nlast`,
    )
    term.dispose()
  })
})
