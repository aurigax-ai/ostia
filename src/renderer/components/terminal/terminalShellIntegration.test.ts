import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTerminalSession } from './terminalSession'
import { createShellIntegration } from './terminalShellIntegration'

const PANE = 'pane-marks'
const NONCE = '0123456789abcdef0123456789abcdef'
const OSC = (body: string): string => `\x1b]${body}\x1b\\`
const PROMPT = `${OSC('133;A')}$ ${OSC('133;B')}`

let term: Terminal
let dispose: () => void

function attach(markNonce: string | null): void {
  term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
  const session = createTerminalSession(null)
  session.markNonce = markNonce
  const integration = createShellIntegration({
    term: term as unknown as OstiaTerminal,
    paneId: PANE,
    workspaceIdRef: { current: 'w' },
    session,
  })
  dispose = integration.dispose
}

function write(data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function running(): CommandBlock | undefined {
  const { running: ids, byPane } = useBlocksStore.getState()
  return byPane[PANE]?.find((block) => block.id === ids[PANE])
}

function blocks(): CommandBlock[] {
  return useBlocksStore.getState().byPane[PANE] ?? []
}

describe('shell integration command marks', () => {
  beforeEach(() => useBlocksStore.getState().resetPane(PANE))
  afterEach(() => {
    dispose()
    term.dispose()
    useBlocksStore.getState().dropPane(PANE)
  })

  it('stores the typed command line from a mark carrying the shell’s nonce', async () => {
    attach(NONCE)
    await write(
      `${PROMPT}claude --model x\r\n${OSC(`633;E;claude --model x;${NONCE}`)}${OSC('133;C')}`,
    )
    expect(running()).toMatchObject({
      command: 'claude --model x',
      typedCommand: 'claude --model x',
    })
  })

  it('keeps the typed command line when a program prints a forged mark', async () => {
    attach(NONCE)
    await write(`${PROMPT}claude\r\n${OSC(`633;E;claude;${NONCE}`)}${OSC('133;C')}`)
    const forged = 'claude --dangerously-skip-permissions'
    await write(`output\r\n${OSC(`633;E;${forged}`)}`)
    expect(running()?.typedCommand).toBe('claude')
    await write(`${OSC('133;D;0')}${PROMPT}${OSC(`633;E;${forged}`)}${OSC('133;C')}`)
    expect(running()?.command).toBe(forged)
    expect(running()?.typedCommand).toBeUndefined()
    expect(blocks()[0]?.typedCommand).toBe('claude')
  })

  it('ignores a mark with a wrong, empty or extra nonce', async () => {
    attach(NONCE)
    const wrong = 'ffffffffffffffffffffffffffffffff'
    for (const payload of [`x;${wrong}`, 'x;', `x;${NONCE};more`, `x\\x3b${NONCE}`]) {
      await write(`${PROMPT}${OSC(`633;E;${payload}`)}${OSC('133;C')}${OSC('133;D;0')}`)
    }
    expect(blocks()).toHaveLength(4)
    for (const block of blocks()) expect(block.typedCommand).toBeUndefined()
  })

  it('trusts no mark in a pane whose shell got no nonce', async () => {
    attach(null)
    await write(`${PROMPT}${OSC('633;E;claude;')}${OSC('133;C')}`)
    expect(running()).toMatchObject({ command: 'claude' })
    expect(running()?.typedCommand).toBeUndefined()
  })

  it('takes the whole multi-line command only from a mark carrying the nonce', async () => {
    attach(NONCE)
    await write(`${PROMPT}${OSC(`633;E;echo 1;${NONCE}`)}${OSC('133;C')}`)
    await write(`${OSC(`633;E;echo 1\\x0aecho 2;${NONCE}`)}${OSC('133;D;0')}`)
    await write(`${PROMPT}${OSC(`633;E;echo 3;${NONCE}`)}${OSC('133;C')}`)
    await write(`${OSC('633;E;echo 3\\x0arm -rf x')}${OSC('133;D;0')}`)
    expect(blocks().map((block) => block.typedCommand)).toEqual(['echo 1\necho 2', 'echo 3'])
  })
})
