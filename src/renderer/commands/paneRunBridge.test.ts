import { registerTerminal } from '@/lib/terminal/terminalHandles'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { wirePaneRunBridge } from './paneRunBridge'

const PANE = 'pane-rerun'

describe('wirePaneRunBridge', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>

  beforeAll(() => {
    blocksInit = useBlocksStore.getState()
  })

  afterEach(() => {
    useBlocksStore.setState(blocksInit, true)
    vi.mocked(window.ostia.pty.onRun).mockClear()
    vi.mocked(window.ostia.pty.write).mockClear()
  })

  function wire(): (paneId: string, command: string) => void {
    wirePaneRunBridge()
    return vi.mocked(window.ostia.pty.onRun).mock.calls[0][0]
  }

  it('runs the command main asks for only once the pane is back at an idle prompt', () => {
    const run = wire()
    const paste = vi.fn()
    const unregister = registerTerminal(PANE, { paste, focus: vi.fn() } as unknown as Terminal)
    const blocks = useBlocksStore.getState()
    blocks.promptStart(PANE, { line: 0 }, '/w')
    blocks.promptEnd(PANE, { line: 0 })
    blocks.commandStart(PANE, { line: 1 }, 'pnpm dev')

    run(PANE, `pnpm dev --title 'my app'`)
    expect(paste).not.toHaveBeenCalled()

    blocks.commandEnd(PANE, { line: 4 }, 130)
    blocks.promptStart(PANE, { line: 5 }, '/w')
    expect(paste).not.toHaveBeenCalled()
    blocks.promptEnd(PANE, { line: 5 })

    expect(paste).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledWith(`pnpm dev --title 'my app'`)
    expect(window.ostia.pty.write).toHaveBeenCalledWith(PANE, '\r')
    unregister()
  })
})
