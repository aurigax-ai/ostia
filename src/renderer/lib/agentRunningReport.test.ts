import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PaneNode } from '../layout/types'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { startAgentRunningReport } from './agentRunningReport'

let layoutInit: ReturnType<typeof useLayoutStore.getState>
let blocksInit: ReturnType<typeof useBlocksStore.getState>

const pane: PaneNode = {
  type: 'pane',
  id: 'p1',
  title: 'claude',
  kind: 'terminal',
  resume: { agent: 'claude', id: 'tok-1' },
}

function run(command: string): void {
  const blocks = useBlocksStore.getState()
  blocks.promptStart('p1', { line: 0 }, null)
  blocks.commandStart('p1', { line: 1 }, command)
}

function end(): void {
  useBlocksStore.getState().commandEnd('p1', { line: 2 }, 0)
}

const reports = () => vi.mocked(window.pine.pty.reportAgentRunning).mock.calls

describe('startAgentRunningReport', () => {
  let stop: (() => void) | null = null

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
    blocksInit = useBlocksStore.getState()
  })

  afterEach(() => {
    stop?.()
    stop = null
    useLayoutStore.setState(layoutInit, true)
    useBlocksStore.setState(blocksInit, true)
    vi.mocked(window.pine.pty.reportAgentRunning).mockClear()
  })

  function start(): void {
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: 'p1', zoomedPaneId: null } },
    })
    stop = startAgentRunningReport()
  }

  it('reports the agent running once when its command starts', () => {
    start()
    run('claude')
    useLayoutStore.getState().focusPane('w1', 'p1')
    expect(reports()).toEqual([['p1', true]])
  })

  it('reports the agent stopped when its command ends while the pane lives', () => {
    start()
    run('claude')
    end()
    expect(reports()).toEqual([
      ['p1', true],
      ['p1', false],
    ])
  })

  it('never reports a stop when the pane is unmounted or reset with the agent running', () => {
    start()
    run('claude')
    useBlocksStore.getState().dropPane('p1')
    useBlocksStore.getState().resetPane('p1')
    expect(reports()).toEqual([['p1', true]])
  })

  it('reports a stop when the human runs another command in a restored pane', () => {
    start()
    run('ls')
    expect(reports()).toEqual([['p1', false]])
  })

  it('reports the agent again after the pane was reset and the agent restarted', () => {
    start()
    run('claude')
    useBlocksStore.getState().resetPane('p1')
    run('claude --resume tok-1')
    expect(reports()).toEqual([
      ['p1', true],
      ['p1', true],
    ])
  })

  it('ignores panes without a resume token', () => {
    useLayoutStore.setState({
      byWorkspace: {
        w1: {
          root: { type: 'pane', id: 'p1', title: 'zsh', kind: 'terminal' },
          activePaneId: 'p1',
          zoomedPaneId: null,
        },
      },
    })
    stop = startAgentRunningReport()
    run('claude')
    end()
    expect(reports()).toEqual([])
  })
})
