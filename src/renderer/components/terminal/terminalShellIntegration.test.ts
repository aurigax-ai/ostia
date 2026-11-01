import type { AgentResume } from '@shared/agents/agentResume'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPane } from '@/lib/layout/tree'
import { rerunBlock } from '@/lib/terminal/blockActions'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { registerTerminal } from '@/lib/terminal/terminalHandles'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { openGhostty, stubCanvas } from '../../../../test/ghosttyTerminal'
import { createTerminalSession, type TerminalSession } from './terminalSession'
import { createShellIntegration } from './terminalShellIntegration'

const PANE = 'pane-marks'
const NONCE = '0123456789abcdef0123456789abcdef'
const OSC = (body: string): string => `\x1b]${body}\x1b\\`
const PROMPT = `${OSC('133;A')}$ ${OSC('133;B')}`

stubCanvas()

let term: OstiaTerminal
let dispose: () => void
let session: TerminalSession

async function attach(markNonce: string | null): Promise<void> {
  term = await openGhostty({ cols: 80, rows: 10 })
  session = createTerminalSession(null)
  session.markNonce = markNonce
  const integration = createShellIntegration({
    term,
    paneId: PANE,
    workspaceIdRef: { current: 'w' },
    session,
    suppressPrompt: vi.fn(),
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
    await attach(NONCE)
    await write(
      `${PROMPT}claude --model x\r\n${OSC(`633;E;claude --model x;${NONCE}`)}${OSC('133;C')}`,
    )
    expect(running()).toMatchObject({
      command: 'claude --model x',
      typedCommand: 'claude --model x',
    })
  })

  it('keeps the typed command line when a program prints a forged mark', async () => {
    await attach(NONCE)
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
    await attach(NONCE)
    const wrong = 'ffffffffffffffffffffffffffffffff'
    for (const payload of [`x;${wrong}`, 'x;', `x;${NONCE};more`, `x\\x3b${NONCE}`]) {
      await write(`${PROMPT}${OSC(`633;E;${payload}`)}${OSC('133;C')}${OSC('133;D;0')}`)
    }
    expect(blocks()).toHaveLength(4)
    for (const block of blocks()) expect(block.typedCommand).toBeUndefined()
  })

  it('trusts no mark in a pane whose shell got no nonce', async () => {
    await attach(null)
    await write(`${PROMPT}${OSC('633;E;claude;')}${OSC('133;C')}`)
    expect(running()).toMatchObject({ command: 'claude' })
    expect(running()?.typedCommand).toBeUndefined()
  })

  it('takes the whole multi-line command only from a mark carrying the nonce', async () => {
    await attach(NONCE)
    await write(`${PROMPT}${OSC(`633;E;echo 1;${NONCE}`)}${OSC('133;C')}`)
    await write(`${OSC(`633;E;echo 1\\x0aecho 2;${NONCE}`)}${OSC('133;D;0')}`)
    await write(`${PROMPT}${OSC(`633;E;echo 3;${NONCE}`)}${OSC('133;C')}`)
    await write(`${OSC('633;E;echo 3\\x0arm -rf x')}${OSC('133;D;0')}`)
    expect(blocks().map((block) => block.typedCommand)).toEqual(['echo 1\necho 2', 'echo 3'])
  })

  it('reruns only the command line the shell vouched for, never a multi-line mark a program printed', async () => {
    await attach(NONCE)
    await write(`${PROMPT}${OSC(`633;E;ls;${NONCE}`)}${OSC('133;C')}`)
    await write(`file\r\n${OSC('633;E;ls\\x0arm -rf ~')}${OSC('133;D;0')}${PROMPT}`)
    expect(blocks()[0]?.command).toBe('ls\nrm -rf ~')
    const unregister = registerTerminal(PANE, term)
    const paste = vi.spyOn(term, 'paste').mockImplementation(() => {})
    vi.spyOn(term, 'focus').mockImplementation(() => {})
    try {
      expect(rerunBlock(PANE, blocks()[0]?.id)).toBe(true)
      expect(paste).toHaveBeenCalledWith('ls')
      expect(paste).not.toHaveBeenCalledWith(expect.stringContaining('rm -rf'))
    } finally {
      unregister()
    }
  })

  it('has no rerun for a whole block a program forged, nor for a pane without a nonce', async () => {
    await attach(NONCE)
    await write(`${PROMPT}${OSC(`633;E;cat notes;${NONCE}`)}${OSC('133;C')}`)
    await write(
      `${OSC('133;D;0')}${PROMPT}${OSC('633;E;rm -rf ~')}${OSC('133;C')}${OSC('133;D;0')}${PROMPT}`,
    )
    const forged = blocks().find((block) => block.command === 'rm -rf ~')
    expect(forged).toBeDefined()
    const unregister = registerTerminal(PANE, term)
    const paste = vi.spyOn(term, 'paste').mockImplementation(() => {})
    vi.spyOn(term, 'focus').mockImplementation(() => {})
    try {
      expect(rerunBlock(PANE, forged?.id)).toBe(false)
      expect(paste).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })
})

describe('the typed launch a pane keeps', () => {
  const TYPED = { args: ['--agent', 'a'], env: { GL_ISSUE: '1' } }
  const LINE = 'GL_ISSUE=1 claude --agent a'

  function seed(resume: AgentResume): void {
    const pane = { type: 'pane', id: PANE, kind: 'terminal', resume } as never
    useLayoutStore.setState({
      byWorkspace: { w: { root: pane, activePaneId: PANE, zoomedPaneId: null } },
    })
  }

  function stored(): AgentResume | undefined {
    const pane = findPane(useLayoutStore.getState().byWorkspace.w.root, PANE)
    return pane?.kind === 'terminal' ? pane.resume : undefined
  }

  beforeEach(async () => {
    useBlocksStore.getState().resetPane(PANE)
    seed({ agent: 'claude', id: 's1', typed: TYPED })
    await attach(NONCE)
  })
  afterEach(() => {
    dispose()
    term.dispose()
    useBlocksStore.getState().dropPane(PANE)
  })

  it('survives a block that restates the same nonce-backed line', async () => {
    await write(`${PROMPT}${OSC(`633;E;${LINE};${NONCE}`)}${OSC('133;C')}`)
    expect(stored()?.typed).toEqual(TYPED)
  })

  it('is cleared by a new block with a nonce-backed line for another program', async () => {
    await write(`${PROMPT}${OSC(`633;E;ls;${NONCE}`)}${OSC('133;C')}`)
    expect(stored()).toEqual({ agent: 'claude', id: 's1' })
  })

  it('is cleared by a new block with no nonce-backed line, such as ssh or an unsupported shell', async () => {
    await write(`${PROMPT}${OSC(`633;E;${LINE}`)}${OSC('133;C')}`)
    expect(stored()).toEqual({ agent: 'claude', id: 's1' })
  })

  it('is kept while a kept shell replays blocks that launch nothing', async () => {
    session.replaying = true
    await write(`${PROMPT}${OSC('633;E;ls')}${OSC('133;C')}`)
    expect(stored()?.typed).toEqual(TYPED)
  })

  it('is cleared by a replayed launch with other flags, nonce or not', async () => {
    session.replaying = true
    await write(`${PROMPT}${OSC('633;E;claude --agent b')}${OSC('133;C')}`)
    expect(stored()).toEqual({ agent: 'claude', id: 's1' })
  })

  it('is never added by a nonce-backed line before an agent reports', async () => {
    seed({ agent: 'claude', id: 's1' })
    await write(`${PROMPT}${OSC(`633;E;${LINE};${NONCE}`)}${OSC('133;C')}`)
    expect(stored()).toEqual({ agent: 'claude', id: 's1' })
  })
})
