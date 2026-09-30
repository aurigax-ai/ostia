import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandBlock } from '../stores/blocksStore'
import { useBlocksStore } from '../stores/blocksStore'
import { runningAgentOf, startAgentDetection } from './paneAgent'

const block = (id: string, command: string) =>
  ({ id, paneId: 'p1', command, startedAt: 0 }) as unknown as CommandBlock

function run(id: string, command: string): void {
  useBlocksStore.setState((s) => ({
    running: { ...s.running, p1: id },
    byPane: { ...s.byPane, p1: [block(id, command)] },
  }))
}

describe('pane agent detection', () => {
  const init = useBlocksStore.getState()
  let stop: (() => void) | null = null

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
    useBlocksStore.setState(init, true)
    vi.mocked(window.pine.pty.foreground).mockReset().mockResolvedValue(null)
  })

  it('knows claude or codex by the command that was typed', () => {
    run('b1', 'claude --model opus')
    expect(runningAgentOf('p1')).toBe('claude')
  })

  it('recognizes an alias once the agent reports its session', () => {
    run('b1', 'cc')
    expect(runningAgentOf('p1')).toBeNull()
    useBlocksStore.getState().markAgent('p1', 'claude')
    expect(runningAgentOf('p1')).toBe('claude')
    run('b2', 'ls')
    expect(runningAgentOf('p1')).toBeNull()
  })

  it('recognizes an alias from the foreground process even without a session id', async () => {
    vi.mocked(window.pine.pty.foreground).mockResolvedValue('claude')
    stop = startAgentDetection()
    run('b1', 'cc')
    await vi.advanceTimersByTimeAsync(1000)
    expect(runningAgentOf('p1')).toBe('claude')
  })

  it('leaves an ordinary command alone', async () => {
    vi.mocked(window.pine.pty.foreground).mockResolvedValue('cargo')
    stop = startAgentDetection()
    run('b1', 'cargo build')
    await vi.advanceTimersByTimeAsync(11_000)
    expect(runningAgentOf('p1')).toBeNull()
  })
})
