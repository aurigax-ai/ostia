import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutNode, PaneNode } from '@/lib/layout/types'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useParkStore } from '@/stores/workspaces/parkStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { WorkspaceKind } from '@/stores/workspaces/workspaceTypes'
import { confirmPark, parkRefusalOf, requestPark } from './parkTab'

const agent: PaneNode = {
  type: 'pane',
  id: 'p1',
  kind: 'terminal',
  title: 'export-tests',
  resume: { agent: 'claude', id: 's1', cwd: '/home/u/api' },
}
const shell: PaneNode = { type: 'pane', id: 'p2', kind: 'terminal', title: 'zsh' }

function seed(root: LayoutNode, kind: WorkspaceKind = 'terminal'): void {
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w1', name: 'alpha', kind, workDir: '/w', state: 'idle' }],
    activeWorkspaceId: 'w1',
  })
  useLayoutStore.setState({
    byWorkspace: { w1: { root, activePaneId: 'p1', zoomedPaneId: null } },
  })
}

function runAgent(): void {
  useBlocksStore.getState().promptStart('p1', { line: 0 }, null)
  useBlocksStore.getState().commandStart('p1', { line: 1 }, 'claude')
  useBlocksStore.getState().markAgent('p1', 'claude')
}

const tabs = (...panes: PaneNode[]): LayoutNode => ({
  type: 'tabs',
  id: 't',
  activeId: panes[0].id,
  children: panes,
})

describe('park from the renderer', () => {
  beforeEach(() => {
    useParkStore.setState({ prompt: null, notice: null })
  })
  afterEach(() => {
    useBlocksStore.setState(useBlocksStore.getInitialState(), true)
    useAttentionStore.setState({ byPane: {} })
    useSandboxStore.setState({ enabled: {} })
    vi.restoreAllMocks()
  })

  it('allows a running idle agent tab', () => {
    seed(tabs(agent, shell))
    runAgent()
    expect(parkRefusalOf('w1', 'p1')).toBeNull()
  })

  it.each([
    ['a plain shell', () => seed(tabs(shell, agent)), 'p2', 'no-agent'],
    ['an agent that is not running', () => seed(tabs(agent, shell)), 'p1', 'no-agent'],
    [
      'a scratch workspace',
      () => {
        seed(tabs(agent, shell), 'scratch')
        runAgent()
      },
      'p1',
      'scratch',
    ],
    [
      'a manager workspace',
      () => {
        seed(tabs(agent, shell), 'manager')
        runAgent()
      },
      'p1',
      'manager',
    ],
    [
      'a sandboxed workspace',
      () => {
        seed(tabs(agent, shell))
        runAgent()
        useSandboxStore.setState({ enabled: { w1: true } })
      },
      'p1',
      'sandboxed',
    ],
    [
      'a locked tab',
      () => {
        seed(tabs({ ...agent, locked: true }, shell))
        runAgent()
      },
      'p1',
      'locked',
    ],
    [
      'an agent that is working',
      () => {
        seed(tabs(agent, shell))
        runAgent()
        useAttentionStore.getState().dispatch('p1', { type: 'set', state: 'working', at: 1 })
      },
      'p1',
      'working',
    ],
  ] as [string, () => void, string, string][])('refuses %s', (_n, arrange, paneId, reason) => {
    arrange()
    expect(parkRefusalOf('w1', paneId)).toBe(reason)
  })

  it('refuses an unknown pane', () => {
    seed(tabs(agent, shell))
    expect(parkRefusalOf('w1', 'nope')).toBe('unavailable')
  })

  it('opens the prompt for a parkable tab and a refusal notice for any other', () => {
    seed(tabs(agent, shell))
    runAgent()
    requestPark('w1', 'p1')
    expect(useParkStore.getState().prompt).toEqual({
      workspaceId: 'w1',
      paneId: 'p1',
      title: 'export-tests',
    })
    useParkStore.setState({ prompt: null })
    requestPark('w1', 'p2')
    expect(useParkStore.getState().prompt).toBeNull()
    expect(useParkStore.getState().notice).toMatchObject({ kind: 'refused', reason: 'no-agent' })
  })

  it('parks through main, then closes the tab and says so', async () => {
    seed(tabs(agent, shell))
    runAgent()
    vi.mocked(window.ostia.park.pane).mockResolvedValue({
      ok: true,
      id: 'abcdefghij',
      title: 'export-tests',
    })
    requestPark('w1', 'p1')
    await confirmPark('after lunch')
    expect(window.ostia.park.pane).toHaveBeenCalledWith('w1', 'p1', 'after lunch')
    expect(useParkStore.getState().prompt).toBeNull()
    expect(useParkStore.getState().notice).toMatchObject({ kind: 'parked', title: 'export-tests' })
    const layout = useLayoutStore.getState().byWorkspace.w1
    expect(JSON.stringify(layout)).not.toContain('"p1"')
  })

  it('keeps the tab and shows main’s reason when main refuses', async () => {
    seed(tabs(agent, shell))
    runAgent()
    vi.mocked(window.ostia.park.pane).mockResolvedValue({ ok: false, reason: 'background-task' })
    requestPark('w1', 'p1')
    await confirmPark('')
    expect(useParkStore.getState().notice).toMatchObject({
      kind: 'refused',
      reason: 'background-task',
      paneId: 'p1',
    })
    expect(JSON.stringify(useLayoutStore.getState().byWorkspace.w1)).toContain('"p1"')
  })

  it('does nothing without a prompt', async () => {
    await confirmPark('x')
    expect(window.ostia.park.pane).not.toHaveBeenCalled()
  })
})
