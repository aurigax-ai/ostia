import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode } from '@/lib/layout/types'
import type { OstiaTerminal as Terminal } from '@/lib/terminal/ostiaTerminal'
import { registerTerminal } from '@/lib/terminal/terminalHandles'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { liveAgentPanes } from '@/stores/workspaces/persistence'
import { startAgentRunningReport } from './agentRunningReport'
import { forkableResume } from './forkConversation'
import { hibernatableAgentPanes } from './hibernationScheduler'
import { runningAgent, runningAgentOf } from './paneAgent'
import { resumeConflict } from './resumeFolder'
import { canInsertReference } from './sendPick'

const PANE = 'p-forged'

const pane: PaneNode = {
  type: 'pane',
  id: PANE,
  title: 'zsh',
  kind: 'terminal',
  resume: { agent: 'claude', id: 'tok-1' },
}

function forgedClaude(): void {
  useBlocksStore.setState((s) => ({
    running: { ...s.running, [PANE]: 'b-forged' },
    byPane: {
      ...s.byPane,
      [PANE]: [
        { id: 'b-forged', paneId: PANE, command: "'claude' --resume tok-1", startedAt: 0 },
      ] as never,
    },
  }))
}

describe('a command line that only names claude', () => {
  const blocks = useBlocksStore.getState()
  const layout = useLayoutStore.getState()
  let unregister: () => void = () => {}

  beforeEach(() => {
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: PANE, zoomedPaneId: null } },
    })
    unregister = registerTerminal(PANE, { paste: vi.fn(), focus: vi.fn() } as unknown as Terminal)
    forgedClaude()
  })

  afterEach(() => {
    unregister()
    useBlocksStore.setState(blocks, true)
    useLayoutStore.setState(layout, true)
    vi.mocked(window.ostia.pty.reportAgentRunning).mockClear()
  })

  it('is no agent to detection, references, saving, forking, hibernation or folder checks', () => {
    expect(runningAgentOf(PANE)).toBeNull()
    expect(runningAgent(PANE)).toBeNull()
    expect(canInsertReference(PANE)).toBe(false)
    expect(liveAgentPanes().has(PANE)).toBe(false)
    expect(forkableResume(pane)).toBeNull()
    expect(hibernatableAgentPanes('w1')).toEqual([])
    expect(resumeConflict(pane)).toBeNull()
  })

  it('never reports the agent running to main', () => {
    const stop = startAgentRunningReport()
    try {
      expect(vi.mocked(window.ostia.pty.reportAgentRunning).mock.calls).toEqual([[PANE, false]])
    } finally {
      stop()
    }
  })

  it('counts once the agent’s own hook or the foreground process marks the block', () => {
    useBlocksStore.getState().markAgent(PANE, 'claude')
    expect(runningAgentOf(PANE)).toBe('claude')
    expect(canInsertReference(PANE)).toBe(true)
    expect(liveAgentPanes().has(PANE)).toBe(true)
  })
})
