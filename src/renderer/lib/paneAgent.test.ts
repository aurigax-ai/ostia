import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttentionStore } from '../stores/attentionStore'
import type { CommandBlock } from '../stores/blocksStore'
import { useBlocksStore } from '../stores/blocksStore'
import {
  isStaleAgentReport,
  runningAgentOf,
  startAgentDetection,
  terminalNotification,
} from './paneAgent'

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

describe('agent attention gates', () => {
  const blocksInit = useBlocksStore.getState()
  const attentionInit = useAttentionStore.getState()
  afterEach(() => {
    useBlocksStore.setState(blocksInit, true)
    useAttentionStore.setState(attentionInit, true)
  })

  it('makes a notification from a plain command unread only, never waiting', () => {
    run('b1', "printf '\\e]9;hello\\a'")
    expect(terminalNotification('p1', 'hello', 5)).toEqual({
      type: 'notify',
      message: 'hello',
      waiting: false,
      at: 5,
    })
    useBlocksStore.setState({
      running: {},
      drafts: { p1: { promptLine: { line: 0 }, inputLine: null, cwd: null } },
    })
    expect(terminalNotification('p1', 'hello', 5).waiting).toBe(false)
  })

  it('makes a notification from a running agent a waiting one', () => {
    run('b1', 'codex')
    expect(terminalNotification('p1', 'Approve?', 5).waiting).toBe(true)
    run('b2', 'my-agent')
    useAttentionStore.getState().dispatch('p1', { type: 'set', state: 'working', at: 1 })
    expect(terminalNotification('p1', 'Approve?', 5).waiting).toBe(true)
  })

  it('treats waiting or working at an idle prompt as a late report from an agent that exited', () => {
    useBlocksStore.setState({
      drafts: { p1: { promptLine: { line: 0 }, inputLine: null, cwd: null } },
    })
    expect(isStaleAgentReport('p1', 'waiting')).toBe(true)
    expect(isStaleAgentReport('p1', 'working')).toBe(true)
    expect(isStaleAgentReport('p1', 'done')).toBe(false)
    expect(isStaleAgentReport('p1', 'none')).toBe(false)
  })

  it('accepts reports while a command runs or when the shell has no integration', () => {
    expect(isStaleAgentReport('p1', 'waiting')).toBe(false)
    run('b1', 'claude')
    expect(isStaleAgentReport('p1', 'waiting')).toBe(false)
  })
})
