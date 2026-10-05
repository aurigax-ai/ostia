import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlocksStore } from '../stores/blocksStore'
import { copyBlock, insertCommand, rerunBlock, runWhenIdle, stepBlock } from './blockActions'
import { registerTerminal } from './terminalHandles'

const PANE = 'pane-actions'

function fakeTerminal(lines: string[], opts: { viewportY?: number; rows?: number } = {}) {
  return {
    rows: opts.rows ?? 5,
    buffer: {
      normal: {
        baseY: 0,
        cursorY: lines.length - 1,
        cursorX: 2,
        viewportY: opts.viewportY ?? 0,
        getLine: (y: number) =>
          y < lines.length
            ? {
                isWrapped: false,
                translateToString: (trim = false, start = 0, end?: number) => {
                  const cells = lines[y].slice(start, end)
                  return trim ? cells.trimEnd() : cells
                },
              }
            : undefined,
      },
    },
    scrollToLine: vi.fn(),
    paste: vi.fn(),
    focus: vi.fn(),
  }
}

function seedTwoBlocks(): void {
  const s = useBlocksStore.getState()
  s.promptStart(PANE, { line: 0 }, '/w')
  s.promptEnd(PANE, { line: 0 })
  s.commandStart(PANE, { line: 1 }, 'echo one')
  s.commandEnd(PANE, { line: 2 }, 0)
  s.promptStart(PANE, { line: 2 }, '/w')
  s.promptEnd(PANE, { line: 2 })
  s.commandStart(PANE, { line: 3 }, 'printf two')
  s.commandEnd(PANE, { line: 4 }, 1)
  s.promptStart(PANE, { line: 4 }, '/w')
  s.promptEnd(PANE, { line: 4 })
}

describe('blockActions', () => {
  let init: ReturnType<typeof useBlocksStore.getState>
  let unregister: () => void
  let term: ReturnType<typeof fakeTerminal>
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeAll(() => {
    init = useBlocksStore.getState()
  })

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    term = fakeTerminal(['$ echo one', 'one', '$ printf two', 'two   ', '$ '])
    unregister = registerTerminal(PANE, term as unknown as Terminal)
    seedTwoBlocks()
  })

  afterEach(() => {
    unregister()
    writeText.mockClear()
    useBlocksStore.setState(init, true)
  })

  const ids = () => (useBlocksStore.getState().byPane[PANE] ?? []).map((b) => b.id)

  it('copies the selected block output with trailing whitespace stripped', async () => {
    useBlocksStore.getState().select(PANE, ids()[1])

    expect(await copyBlock(PANE, 'output')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('two')
  })

  it('copies command and output together for a specific block', async () => {
    await copyBlock(PANE, 'both', ids()[0])
    expect(writeText).toHaveBeenCalledWith('echo one\none')
  })

  it('falls back to the latest block when nothing is selected', async () => {
    await copyBlock(PANE, 'command')
    expect(writeText).toHaveBeenCalledWith('printf two')
  })

  it('reports false when the pane has no terminal', async () => {
    expect(await copyBlock('nope', 'output')).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('steps the selection backwards and scrolls an off-screen block into view', () => {
    unregister()
    term = fakeTerminal(['$ echo one', 'one', '$ printf two', 'two', '$ '], {
      viewportY: 3,
      rows: 2,
    })
    unregister = registerTerminal(PANE, term as unknown as Terminal)

    expect(stepBlock(PANE, 'prev')).toBe(ids()[1])
    expect(term.scrollToLine).toHaveBeenCalledWith(2)
    expect(stepBlock(PANE, 'prev')).toBe(ids()[0])
    expect(term.scrollToLine).toHaveBeenLastCalledWith(0)
    expect(useBlocksStore.getState().selected[PANE]).toBe(ids()[0])
  })

  it('reruns a block by pasting its command and pressing Enter at an idle prompt', () => {
    expect(rerunBlock(PANE, ids()[0])).toBe(true)
    expect(term.paste).toHaveBeenCalledWith('echo one')
    expect(window.ostia.pty.write).toHaveBeenCalledWith(PANE, '\r')
  })

  it('refuses to type into a pane while a command is running', () => {
    useBlocksStore.getState().commandStart(PANE, { line: 5 }, 'sleep 10')

    expect(rerunBlock(PANE, ids()[0])).toBe(false)
    expect(insertCommand(PANE, 'ls')).toBe(false)
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('inserts a command without executing it', () => {
    expect(insertCommand(PANE, 'git log')).toBe(true)
    expect(term.paste).toHaveBeenCalledWith('git log')
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
  })
})

describe('runWhenIdle', () => {
  const NEW = 'pane-new'
  let init: ReturnType<typeof useBlocksStore.getState>
  let unregister: () => void
  let term: ReturnType<typeof fakeTerminal>

  beforeAll(() => {
    init = useBlocksStore.getState()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    term = fakeTerminal(['$ '])
    unregister = registerTerminal(NEW, term as unknown as Terminal)
  })

  afterEach(() => {
    unregister()
    vi.useRealTimers()
    useBlocksStore.setState(init, true)
  })

  it('waits for the fresh shell to finish drawing its prompt, then runs once', () => {
    runWhenIdle(NEW, 'sudo pacman -S --needed ripgrep')
    expect(term.paste).not.toHaveBeenCalled()

    useBlocksStore.getState().promptStart(NEW, { line: 0 }, '/home')
    expect(term.paste).not.toHaveBeenCalled()

    useBlocksStore.getState().promptEnd(NEW, { line: 0 })
    expect(term.paste).toHaveBeenCalledWith('sudo pacman -S --needed ripgrep')
    expect(window.ostia.pty.write).toHaveBeenCalledWith(NEW, '\r')

    const s = useBlocksStore.getState()
    s.commandStart(NEW, { line: 1 }, 'sudo pacman -S --needed ripgrep')
    s.commandEnd(NEW, { line: 2 }, 0)
    s.promptStart(NEW, { line: 2 }, '/home')
    s.promptEnd(NEW, { line: 2 })
    expect(term.paste).toHaveBeenCalledTimes(1)
  })

  it('does not type while something is running in the pane', () => {
    const s = useBlocksStore.getState()
    s.promptStart(NEW, { line: 0 }, '/home')
    s.promptEnd(NEW, { line: 0 })
    s.commandStart(NEW, { line: 1 }, 'vim')
    runWhenIdle(NEW, 'echo later')
    expect(term.paste).not.toHaveBeenCalled()

    s.commandEnd(NEW, { line: 2 }, 0)
    s.promptStart(NEW, { line: 2 }, '/home')
    s.promptEnd(NEW, { line: 2 })
    expect(term.paste).toHaveBeenCalledWith('echo later')
  })

  it('gives up after the timeout and never types into the pane later', () => {
    runWhenIdle(NEW, 'echo late', 1000)
    vi.advanceTimersByTime(1000)
    const s = useBlocksStore.getState()
    s.promptStart(NEW, { line: 0 }, '/home')
    s.promptEnd(NEW, { line: 0 })
    expect(term.paste).not.toHaveBeenCalled()
  })

  it('can be cancelled before the prompt appears', () => {
    const cancel = runWhenIdle(NEW, 'echo never')
    cancel()
    const s = useBlocksStore.getState()
    s.promptStart(NEW, { line: 0 }, '/home')
    s.promptEnd(NEW, { line: 0 })
    expect(term.paste).not.toHaveBeenCalled()
  })
})
