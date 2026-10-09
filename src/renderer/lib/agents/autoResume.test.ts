import { createPane, findPane, tabsOf } from '@/layout/tree'
import type { LayoutNode } from '@/layout/types'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { SnapshotPaneNode } from '@shared/types'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/terminal/blockActions', () => ({ runWhenIdle: vi.fn(() => vi.fn()) }))

const { runWhenIdle } = await import('@/lib/terminal/blockActions')
const { keptShellReattached, resumeOnActivation, startAutoResume, workspacesAwaitingResume } =
  await import('./autoResume')
const { startActivationResume } = await import('./activationResume')

const resume = { agent: 'claude' as const, id: 'abc-1' }

function seed(root: LayoutNode, activePaneId: string, autoResume: boolean): void {
  useSettingsStore.setState((s) => ({ agents: { ...s.agents, autoResume } }))
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w1', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
    activeWorkspaceId: 'w1',
  })
  useLayoutStore.setState({ byWorkspace: { w1: { root, activePaneId, zoomedPaneId: null } } })
}

const scheduled = () =>
  vi.mocked(runWhenIdle).mock.calls.map(([paneId, command]) => [paneId, command])

const pending = (id: string) => findPane(useLayoutStore.getState().byWorkspace.w1.root, id)

function savedAgent(id: string, resumeId: string, agentRunning: boolean): SnapshotPaneNode {
  return {
    type: 'pane',
    id,
    title: 'claude',
    kind: 'terminal',
    cwd: '/w',
    resume: { agent: 'claude', id: resumeId },
    ...(agentRunning ? { agentRunning: true } : {}),
  }
}

function restart(autoResume: boolean, agentRunning = true): void {
  useSettingsStore.setState((s) => ({ agents: { ...s.agents, autoResume } }))
  useWorkspacesStore.getState().hydrate({
    v: 1,
    savedAt: '',
    activeWorkspaceId: 's1',
    groups: [],
    workspaces: [
      {
        id: 's1',
        name: 'agents',
        kind: 'terminal',
        workDir: '/w',
        root: {
          type: 'tabs',
          id: 'tabs-1',
          activeId: 'pane-1',
          children: [
            savedAgent('pane-1', 'front-1111', agentRunning),
            savedAgent('pane-2', 'back-2222', agentRunning),
          ],
        },
        activePaneId: 'pane-1',
      },
      {
        id: 's2',
        name: 'elsewhere',
        kind: 'terminal',
        workDir: '/w',
        root: savedAgent('pane-3', 'other-3333', agentRunning),
        activePaneId: 'pane-3',
      },
    ],
  })
}

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

    expect(scheduled()).toEqual([[pane.id, 'claude --resume abc-1']])
    expect(pending(pane.id)?.resumePending).toBe(true)

    useBlocksStore.setState({ running: { [pane.id]: 'b1' } })
    expect(pending(pane.id)?.resumePending).toBeUndefined()
  })

  it('drops a scheduled resume when Ostia reattaches the pane with its agent still running', () => {
    const pane = { ...createPane('terminal'), resume, resumePending: true as const }
    seed(pane, pane.id, true)
    const cancel = vi.fn()
    vi.mocked(runWhenIdle).mockReturnValueOnce(cancel)
    stop = startAutoResume()
    expect(runWhenIdle).toHaveBeenCalledTimes(1)

    keptShellReattached('w1', pane.id)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(pending(pane.id)?.resumePending).toBeUndefined()
  })

  it('never types a resume into a hibernated pane; waking it stays with the human', () => {
    const pane = {
      ...createPane('terminal'),
      resume,
      resumePending: true as const,
      hibernated: true as const,
    }
    seed(pane, pane.id, true)
    stop = startAutoResume()
    expect(runWhenIdle).not.toHaveBeenCalled()
    expect(workspacesAwaitingResume(useLayoutStore.getState().byWorkspace)).toEqual([])
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

    expect(scheduled()).toEqual([
      [back.id, 'claude --resume abc-1'],
      [other.id, 'claude --resume abc-1'],
    ])
  })

  it('types nothing and forgets the mark when the agent folder turned out to be gone', () => {
    const pane = {
      ...createPane('terminal'),
      resume: { ...resume, cwd: '/w/tree' },
      resumePending: true as const,
      spawnDir: '/w/tree',
    }
    seed(pane, pane.id, true)
    const cancel = vi.fn()
    vi.mocked(runWhenIdle).mockReturnValueOnce(cancel)
    stop = startAutoResume()
    expect(runWhenIdle).toHaveBeenCalledTimes(1)
    const guard = vi.mocked(runWhenIdle).mock.calls[0][3]
    expect(guard?.()).toBe(true)

    useLayoutStore.getState().settleSpawnDir('w1', pane.id, true)
    expect(guard?.()).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(pending(pane.id)?.resumePending).toBeUndefined()
    expect(pending(pane.id)?.resumeFolderMissing).toBe('/w/tree')
  })

  it('types nothing at startup when the setting is off and keeps the mark for the human', () => {
    const pane = { ...createPane('terminal'), resume, resumePending: true as const }
    seed(pane, pane.id, false)
    stop = startAutoResume()
    expect(runWhenIdle).not.toHaveBeenCalled()
    expect(pending(pane.id)?.resumePending).toBe(true)
  })

  it('resumes a marked pane once when the human activates it with the setting off', () => {
    const pane = { ...createPane('terminal'), resume, resumePending: true as const }
    seed(pane, pane.id, false)
    stop = startAutoResume()

    resumeOnActivation(pane.id)
    resumeOnActivation(pane.id)
    expect(scheduled()).toEqual([[pane.id, 'claude --resume abc-1']])

    useBlocksStore.setState({ running: { [pane.id]: 'b1' } })
    expect(pending(pane.id)?.resumePending).toBeUndefined()
    useBlocksStore.setState({ running: {} })
    resumeOnActivation(pane.id)
    expect(runWhenIdle).toHaveBeenCalledTimes(1)
  })

  it('never resumes on activation a pane without the mark', () => {
    const pane = { ...createPane('terminal'), resume }
    seed(pane, pane.id, false)
    stop = startAutoResume()
    resumeOnActivation(pane.id)
    expect(runWhenIdle).not.toHaveBeenCalled()
  })

  it('never resumes on activation while a command runs in the pane', () => {
    const pane = { ...createPane('terminal'), resume, resumePending: true as const }
    seed(pane, pane.id, false)
    useBlocksStore.setState({ running: { [pane.id]: 'b1' } })
    stop = startAutoResume()
    resumeOnActivation(pane.id)
    expect(runWhenIdle).not.toHaveBeenCalled()
    expect(pending(pane.id)?.resumePending).toBeUndefined()
  })

  it('never resumes on activation when the agent folder is gone', () => {
    const pane = {
      ...createPane('terminal'),
      resume: { ...resume, cwd: '/w/tree' },
      resumePending: true as const,
      resumeFolderMissing: '/w/tree',
    }
    seed(pane, pane.id, false)
    stop = startAutoResume()
    resumeOnActivation(pane.id)
    expect(runWhenIdle).not.toHaveBeenCalled()
    expect(pending(pane.id)?.resumeFolderMissing).toBe('/w/tree')
  })

  it('wakes a hibernated pane when the human activates it', () => {
    const pane = { ...createPane('terminal'), resume, hibernated: true as const }
    seed(pane, pane.id, false)
    stop = startAutoResume()
    resumeOnActivation(pane.id)
    expect(pending(pane.id)?.hibernated).toBeUndefined()
    expect(scheduled()).toEqual([[pane.id, 'claude --resume abc-1']])
  })

  it('with auto-resume on, every agent resumes at startup: shown tab, background tab and unopened workspace', () => {
    restart(true)
    stop = startAutoResume()

    expect(scheduled()).toEqual([
      ['pane-1', 'claude --resume front-1111'],
      ['pane-2', 'claude --resume back-2222'],
      ['pane-3', 'claude --resume other-3333'],
    ])
  })

  it('with auto-resume off, a restored agent waits until the human activates its tab', () => {
    const listeners = new Map<string, EventListener>()
    const add = window.addEventListener.bind(window)
    const spy = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((type, listener, options) => {
        if (typeof listener === 'function') listeners.set(type, listener)
        add(type, listener, options)
      })
    restart(false)
    const stopAuto = startAutoResume()
    const stopActivation = startActivationResume()
    spy.mockRestore()
    stop = () => {
      stopActivation()
      stopAuto()
    }
    expect(runWhenIdle).not.toHaveBeenCalled()

    listeners.get('pointerdown')?.({ type: 'pointerdown', isTrusted: true } as Event)
    useLayoutStore.getState().focusPane('s1', 'pane-2')

    expect(scheduled()).toEqual([['pane-2', 'claude --resume back-2222']])
  })

  it('an agent that exited before the quit does not resume after the restart', () => {
    restart(true, false)
    stop = startAutoResume()

    expect(runWhenIdle).not.toHaveBeenCalled()
    expect(workspacesAwaitingResume(useLayoutStore.getState().byWorkspace)).toEqual([])
  })

  it('a woken agent starts in the folder its session belongs to, not the pane’s folder', () => {
    const pane = {
      ...createPane('terminal'),
      cwd: '/w',
      resume: { ...resume, cwd: '/w/tree' },
      hibernated: true as const,
    }
    seed(pane, pane.id, false)
    stop = startAutoResume()
    resumeOnActivation(pane.id)
    expect(pending(pane.id)?.spawnDir).toBe('/w/tree')
    expect(scheduled()).toEqual([[pane.id, 'claude --resume abc-1']])

    useLayoutStore.getState().settleSpawnDir('w1', pane.id, false)
    const typeable = vi.mocked(runWhenIdle).mock.calls[0][3]
    expect(typeable?.()).toBe(true)
    expect(pending(pane.id)?.resumeFolderMissing).toBeUndefined()
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
