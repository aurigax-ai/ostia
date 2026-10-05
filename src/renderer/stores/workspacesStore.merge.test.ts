import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { paneIds, resetIds, tabsOf } from '../layout/tree'
import type { LayoutNode, PaneNode } from '../layout/types'
import { useLayoutStore } from './layoutStore'
import { useSettingsStore } from './settingsStore'
import { type Workspace, useWorkspacesStore } from './workspacesStore'

const pane = (id: string): PaneNode => ({ type: 'pane', id, title: 'zsh', kind: 'terminal' })

function workspace(id: string, over: Partial<Workspace> = {}): Workspace {
  return { id, name: id, kind: 'terminal', workDir: '/home/u/proj', state: 'idle', ...over }
}

function layout(root: LayoutNode, activePaneId: string) {
  return { root, activePaneId, zoomedPaneId: null }
}

const emitted = () => vi.mocked(window.ostia.lifecycle.emit).mock.calls.map(([e]) => e)

describe('workspacesStore.merge', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
    resetIds()
    vi.clearAllMocks()
  })

  function seed(): void {
    useWorkspacesStore.setState({
      workspaces: [
        workspace('w1', { pinned: true, customName: 'main' }),
        workspace('w2', { groupId: 'g1', description: 'side' }),
        workspace('w3', { groupId: 'g1' }),
      ],
      groups: [{ id: 'g1', name: 'team' }],
      activeWorkspaceId: 'w2',
    })
    useLayoutStore.setState({
      byWorkspace: {
        w1: { ...layout(pane('p1'), 'p1'), zoomedPaneId: 'p1' },
        w2: layout(tabsOf('p3', pane('p2'), pane('p3')), 'p3'),
        w3: layout(pane('p4'), 'p4'),
      },
    })
  }

  it('moves every source pane into the target with the same ids', () => {
    seed()
    useWorkspacesStore.getState().merge('w2', 'w1')

    const { byWorkspace } = useLayoutStore.getState()
    expect(byWorkspace.w2).toBeUndefined()
    expect(paneIds(byWorkspace.w1.root).sort()).toEqual(['p1', 'p2', 'p3'])
  })

  it('removes the source workspace and keeps the target’s own pin and name', () => {
    seed()
    useWorkspacesStore.getState().merge('w2', 'w1')

    const { workspaces, groups } = useWorkspacesStore.getState()
    expect(workspaces.map((w) => w.id)).toEqual(['w1', 'w3'])
    expect(workspaces[0]).toMatchObject({ pinned: true, customName: 'main' })
    expect(groups).toEqual([{ id: 'g1', name: 'team' }])
  })

  it('drops a group the source was the last member of', () => {
    seed()
    useWorkspacesStore.getState().merge('w3', 'w2')
    useWorkspacesStore.getState().merge('w2', 'w1')

    expect(useWorkspacesStore.getState().groups).toEqual([])
  })

  it('emits no pane-closed or workspace-closed, only the target’s activation', () => {
    seed()
    useWorkspacesStore.getState().merge('w2', 'w1')

    expect(emitted()).toEqual([{ type: 'workspace-activated', workspaceId: 'w1' }])
  })

  it('activates the target, focuses the source’s active pane and clears the zoom', () => {
    seed()
    useWorkspacesStore.getState().merge('w2', 'w1')

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('w1')
    const target = useLayoutStore.getState().byWorkspace.w1
    expect(target.activePaneId).toBe('p3')
    expect(target.zoomedPaneId).toBeNull()
  })

  it('gives an empty target the source’s layout as it was', () => {
    seed()
    useLayoutStore.setState((s) => {
      const { w1: _gone, ...byWorkspace } = s.byWorkspace
      return { byWorkspace }
    })
    const source = useLayoutStore.getState().byWorkspace.w2

    useWorkspacesStore.getState().merge('w2', 'w1')

    expect(useLayoutStore.getState().byWorkspace.w1).toBe(source)
  })

  it('closes an empty source without touching the target’s layout', () => {
    seed()
    useLayoutStore.setState((s) => {
      const { w2: _gone, ...byWorkspace } = s.byWorkspace
      return { byWorkspace }
    })
    const target = useLayoutStore.getState().byWorkspace.w1

    useWorkspacesStore.getState().merge('w2', 'w1')

    expect(useLayoutStore.getState().byWorkspace.w1).toBe(target)
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(['w1', 'w3'])
  })

  it('does nothing for an unknown workspace or a merge into itself', () => {
    seed()
    const before = useWorkspacesStore.getState().workspaces
    useWorkspacesStore.getState().merge('w2', 'w2')
    useWorkspacesStore.getState().merge('nope', 'w1')

    expect(useWorkspacesStore.getState().workspaces).toBe(before)
    expect(emitted()).toEqual([])
  })
})
