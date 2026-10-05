import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import { FORM_FEED, clearKeepingScrollback } from './clearTerminal'

const terms: Terminal[] = []

function open(): { term: Terminal; sent: string[] } {
  const term = new Terminal({ cols: 20, rows: 6, scrollback: 100 })
  terms.push(term)
  const sent: string[] = []
  term.onData((d) => sent.push(d))
  return { term, sent }
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function lines(term: Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
  return out
}

afterEach(() => {
  for (const t of terms.splice(0)) t.dispose()
})

describe('clearKeepingScrollback on a real xterm buffer', () => {
  it('moves everything up to the prompt into scrollback and asks the shell to redraw', async () => {
    const { term, sent } = open()
    await write(term, 'old\r\n')
    await write(term, 'one\r\ntwo\r\n$ ls')
    expect(await clearKeepingScrollback(term, true)).toBe(true)
    const buf = term.buffer.active
    expect(buf.baseY).toBe(4)
    expect(lines(term).slice(0, 4)).toEqual(['old', 'one', 'two', '$ ls'])
    expect(
      lines(term)
        .slice(4)
        .every((l) => l === ''),
    ).toBe(true)
    expect([buf.cursorX, buf.cursorY]).toEqual([0, 0])
    expect(sent).toEqual([FORM_FEED])
  })

  it('keeps scrollback that was already there and adds no blank gap', async () => {
    const { term } = open()
    for (let i = 0; i < 10; i++) await write(term, `line ${i}\r\n`)
    await write(term, '$ ')
    const before = term.buffer.active.baseY
    await clearKeepingScrollback(term, true)
    const all = lines(term)
    expect(term.buffer.active.baseY).toBe(before + term.rows)
    expect(all.slice(0, 11)).toEqual([...Array.from({ length: 10 }, (_, i) => `line ${i}`), '$ '])
  })

  it('does not type into a running command', async () => {
    const { term, sent } = open()
    await write(term, 'building...')
    expect(await clearKeepingScrollback(term, false)).toBe(true)
    expect(lines(term)[0]).toBe('building...')
    expect(sent).toEqual([])
  })

  it('leaves full-screen programs on the alternate screen alone', async () => {
    const { term, sent } = open()
    await write(term, '\x1b[?1049hvim')
    expect(await clearKeepingScrollback(term, true)).toBe(false)
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('vim')
    expect(sent).toEqual([])
  })
})
