import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { shellLineHoldsText } from './shellLineText'

let term: Terminal

function write(data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function open(cols = 20): OstiaTerminal {
  term = new Terminal({ cols, rows: 10, allowProposedApi: true })
  return term as unknown as OstiaTerminal
}

const AT_B = { line: 0, col: 2 }

describe('shellLineHoldsText', () => {
  afterEach(() => term.dispose())

  it('is false while the cursor sits at the prompt end', async () => {
    const t = open()
    await write('$ ')
    expect(shellLineHoldsText(t, AT_B)).toBe(false)
  })

  it('is true when typeahead follows the prompt end', async () => {
    const t = open()
    await write('$ late')
    expect(shellLineHoldsText(t, AT_B)).toBe(true)
  })

  it('is true when the typeahead wraps onto the next row', async () => {
    const t = open()
    await write(`$ ${'x'.repeat(30)}`)
    expect(shellLineHoldsText(t, AT_B)).toBe(true)
  })

  it('is false when output moves the cursor to another line without text after the prompt end', async () => {
    const t = open()
    await write('$ \r\n[1] + done\r\n$ ')
    expect(shellLineHoldsText(t, AT_B)).toBe(false)
  })

  it('is false for a right prompt that the cursor has not passed', async () => {
    const t = open()
    await write('$ \x1b[10Cgit\x1b[12D')
    expect(shellLineHoldsText(t, AT_B)).toBe(false)
  })
})
