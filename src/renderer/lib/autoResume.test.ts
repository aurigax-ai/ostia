import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane, findPane, tabsOf } from '../layout/tree'
import type { LayoutNode } from '../layout/types'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

vi.mock('./blockActions', () => ({ runWhenIdle: vi.fn(() => vi.fn()) }))

const { runWhenIdle } = await import('./blockActions')
const { startAutoResume, workspacesAwaitingResume } = await import('./autoResume')

const resume = { agent: 'claude' as const, id: 'abc-1' }

function seed(root: LayoutNode, activePaneId: string, autoResume: boolean): void {
  useSettingsStore.setState((s) => ({ agents: { ...s.agents, autoResume } }))
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w1', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
    activeWorkspaceId: 'w1',
  })
  useLayoutStore.setState({ byWorkspace: { w1: { root, activePaneId, zoomedPaneId: null } } })
}

const pending = (id: string) => findPane(useLayoutStore.getState().byWorkspace.w1.root, id)

describe('startAutoResume', () => {
  let stop: (() => void) | null = null
  const init = {
    layout: useLayoutStore.getState(),
    workspaces: useWorkspacesStore.getState(),
    settings: useSettingsStore.getState(),
    blocks: useBlocksStore.getState(),
  }

  beforeAll(() => vi.mocked(runWhenIdle).mockClear())

  afterEach(() => {
    stop?.()
    stop = null
    vi.mocked(runWhenIdle).mockClear()
    useLayoutStore.setState(init.layout, true)
    useWorkspacesStore.setState(init.workspaces, true)
    useSettingsStore.setState(init.settings, true)
    useBlocksStore.setState(init.blocks, true)
  })

  it('resumes a pane that was running an agent once, keeping the mark until the agent runs', () => {
    const pane = { ...createPane('terminal'), resume, resumePending: true as const }
    seed(pane, pane.id, true)
    stop = startAutoResume()
    useLayoutStore.setState((s) => ({ byWorkspace: { ...s.byWorkspace } }))

    expect(vi.mocked(runWhenIdle).mock.calls).toEqual([[pane.id, 'claude --resume abc-1']])
    expect(pending(pane.id)?.resumePending).toBe(true)

    useBlocksStore.setState({ running: { [pane.id]: 'b1' } })
    expect(pending(pane.id)?.resumePending).toBeUndefined()
  })

  it('resumes a background tab and another workspace without waiting to be shown', () => {
    const front = createPane('terminal')
    const back = { ...createPane('terminal'), resume, resumePending: true as const }
    const other = { ...createPane('terminal'), resume, resumePending: true as const }
    seed(tabsOf(front.id, front, back), front.id, true)
    useLayoutStore.setState((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        w2: { root: other, activePaneId: other.id, zoomedPaneId: null },
      },
    }))
    expect(workspacesAwaitingResume(useLayoutStore.getState().byWorkspace)).toEqual(['w1', 'w2'])
    stop = startAutoResume()

    expect(vi.mocked(runWhenIdle).mock.calls).toEqual([
      [back.id, 'claude --resume abc-1'],
      [other.id, 'claude --resume abc-1'],
    ])
  })

  it('does nothing and forgets the mark when the setting is off', () => {
    const pane = { ...createPane('terminal'), resume, resumePending: true as const }
    seed(pane, pane.id, false)
    stop = startAutoResume()
    expect(runWhenIdle).not.toHaveBeenCalled()
    expect(pending(pane.id)?.resumePending).toBeUndefined()
  })

  it('drops the resume when the human runs something in the pane first', () => {
    const front = createPane('terminal')
    const back = { ...createPane('terminal'), resume, resumePending: true as const }
    seed(tabsOf(front.id, front, back), front.id, true)
    stop = startAutoResume()

    const cancel = vi.mocked(runWhenIdle).mock.results[0]?.value
    useBlocksStore.setState({ running: { [back.id]: 'b1' } })
    expect(pending(back.id)?.resumePending).toBeUndefined()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
