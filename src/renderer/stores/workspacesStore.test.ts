import type { AppSnapshot } from '@shared/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLayoutStore } from './layoutStore'
import { useWorkspacesStore } from './workspacesStore'

const ensureMock = () => vi.mocked(useLayoutStore.getState().ensure)
const removeWorkspaceMock = () => vi.mocked(useLayoutStore.getState().removeWorkspace)
const workspaces = () => useWorkspacesStore.getState().workspaces
const activeId = () => useWorkspacesStore.getState().activeWorkspaceId
const open = (workDir?: string) => {
  useWorkspacesStore.getState().addWorkspace(workDir)
  return workspaces()[workspaces().length - 1]
}

describe('workspacesStore', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  beforeEach(() => {
    vi.spyOn(useLayoutStore.getState(), 'ensure').mockImplementation(() => {})
    vi.spyOn(useLayoutStore.getState(), 'removeWorkspace').mockImplementation(() => {})
    vi.spyOn(useLayoutStore.getState(), 'hydrate').mockImplementation(() => {})
  })

  afterEach(() => {
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    vi.restoreAllMocks()
  })

  it('starts with no workspaces and no active workspace', () => {
    expect(workspaces()).toEqual([])
    expect(activeId()).toBeNull()
  })

  describe('addWorkspace', () => {
    it('appends a focused, empty workspace named from its workDir', () => {
      open()
      useWorkspacesStore.getState().addWorkspace('/home/me/projects/app')

      expect(workspaces()).toHaveLength(2)
      const added = workspaces()[1]
      expect(added.workDir).toBe('/home/me/projects/app')
      expect(added.name).toBe('app')
      expect(activeId()).toBe(added.id)
      expect(ensureMock()).not.toHaveBeenCalled()
    })

    it('inserts at the top, after the current one, or at the end per placement', () => {
      const a = open('/a')
      open('/b')
      useWorkspacesStore.getState().setActive(a.id)
      useWorkspacesStore.getState().addWorkspace('/c', 'afterCurrent')
      useWorkspacesStore.getState().addWorkspace('/d', 'top')
      useWorkspacesStore.getState().addWorkspace('/e', 'end')

      expect(workspaces().map((w) => w.workDir)).toEqual(['/d', '/a', '/c', '/b', '/e'])
      expect(activeId()).toBe(workspaces()[4].id)
    })

    it('defaults workDir to ~ (name "home") when called with no arg', () => {
      useWorkspacesStore.getState().addWorkspace()

      expect(workspaces()).toHaveLength(1)
      const added = workspaces()[0]
      expect(added.workDir).toBe('~')
      expect(added.name).toBe('home')
      expect(activeId()).toBe(added.id)
    })
  })

  describe('setActive', () => {
    it('sets activeWorkspaceId to the given id', () => {
      const first = open()
      useWorkspacesStore.getState().addWorkspace('/x/y')
      expect(activeId()).not.toBe(first.id)

      useWorkspacesStore.getState().setActive(first.id)

      expect(activeId()).toBe(first.id)
    })
  })

  describe('setWorkDir', () => {
    it('re-anchors the workspace and re-derives its name from the new workDir', () => {
      const id = open().id

      useWorkspacesStore.getState().setWorkDir(id, '/x/y')

      const updated = workspaces().find((s) => s.id === id)
      expect(updated?.workDir).toBe('/x/y')
      expect(updated?.name).toBe('y')
    })

    it('touches ONLY the target workspace, leaving the others untouched', () => {
      useWorkspacesStore.getState().addWorkspace('/a/one')
      useWorkspacesStore.getState().addWorkspace('/b/two')
      useWorkspacesStore.getState().addWorkspace('/c/three')
      const [a, b, c] = workspaces()

      useWorkspacesStore.getState().setWorkDir(b.id, '/x/y')

      const [na, nb, nc] = workspaces()
      expect(workspaces().map((s) => s.id)).toEqual([a.id, b.id, c.id])
      expect(nb.workDir).toBe('/x/y')
      expect(nb.name).toBe('y')
      expect(na).toBe(a)
      expect(nc).toBe(c)
    })
  })

  describe('closeWorkspace', () => {
    it('removes a non-active workspace, leaves the active one, and drops its layout', () => {
      const first = open()
      useWorkspacesStore.getState().addWorkspace('/x/y')
      const second = workspaces()[1]
      expect(activeId()).toBe(second.id)

      useWorkspacesStore.getState().closeWorkspace(first.id)

      expect(workspaces().map((s) => s.id)).toEqual([second.id])
      expect(activeId()).toBe(second.id)
      expect(removeWorkspaceMock()).toHaveBeenCalledWith(first.id)
    })

    it('falls to the RIGHT neighbour when the active LEFTMOST workspace closes', () => {
      useWorkspacesStore.getState().addWorkspace('/a')
      useWorkspacesStore.getState().addWorkspace('/b')
      useWorkspacesStore.getState().addWorkspace('/c')
      const [a, b, c] = workspaces()
      useWorkspacesStore.getState().setActive(a.id)

      useWorkspacesStore.getState().closeWorkspace(a.id)

      expect(workspaces().map((s) => s.id)).toEqual([b.id, c.id])
      expect(activeId()).toBe(b.id)
      expect(removeWorkspaceMock()).toHaveBeenCalledWith(a.id)
    })

    it('falls to the LEFT neighbour when the active workspace closes', () => {
      useWorkspacesStore.getState().addWorkspace('/a')
      useWorkspacesStore.getState().addWorkspace('/b')
      useWorkspacesStore.getState().addWorkspace('/c')
      const [a, b, c] = workspaces()
      expect(workspaces()).toHaveLength(3)
      useWorkspacesStore.getState().setActive(b.id)

      useWorkspacesStore.getState().closeWorkspace(b.id)

      expect(workspaces().map((s) => s.id)).toEqual([a.id, c.id])
      expect(activeId()).toBe(a.id)
      expect(removeWorkspaceMock()).toHaveBeenCalledWith(b.id)
    })

    it('leaves zero workspaces and no active workspace when the last one closes', () => {
      const original = open()
      ensureMock().mockClear()

      useWorkspacesStore.getState().closeWorkspace(original.id)

      expect(workspaces()).toEqual([])
      expect(activeId()).toBeNull()
      expect(removeWorkspaceMock()).toHaveBeenCalledWith(original.id)
      expect(ensureMock()).not.toHaveBeenCalled()
    })

    it('mints a fresh id for a workspace opened after the last one closed', () => {
      const original = open()
      useWorkspacesStore.getState().closeWorkspace(original.id)

      const next = open()

      expect(next.id).not.toBe(original.id)
      expect(activeId()).toBe(next.id)
    })
  })

  describe('setState', () => {
    it("updates the target workspace's state and mirrors a workspace-state lifecycle event", () => {
      const id = open().id
      const emitSpy = vi.mocked(window.pine.lifecycle.emit)

      useWorkspacesStore.getState().setState(id, 'waiting')

      expect(workspaces().find((s) => s.id === id)?.state).toBe('waiting')
      expect(emitSpy).toHaveBeenCalledWith({
        type: 'workspace-state',
        workspaceId: id,
        state: 'waiting',
      })
    })

    it('touches ONLY the target workspace, leaving the others untouched', () => {
      useWorkspacesStore.getState().addWorkspace('/a/one')
      useWorkspacesStore.getState().addWorkspace('/b/two')
      useWorkspacesStore.getState().addWorkspace('/c/three')
      const [a, b, c] = workspaces()

      useWorkspacesStore.getState().setState(b.id, 'working')

      const [na, nb, nc] = workspaces()
      expect(nb.state).toBe('working')
      expect(na).toBe(a)
      expect(nc).toBe(c)
    })

    it('is a no-op (no state change, no emit) when the workspace is already in that state', () => {
      const id = open().id
      vi.mocked(window.pine.lifecycle.emit).mockClear()
      expect(workspaces().find((s) => s.id === id)?.state).toBe('idle')
      const emitSpy = vi.mocked(window.pine.lifecycle.emit)

      useWorkspacesStore.getState().setState(id, 'idle')

      expect(emitSpy).not.toHaveBeenCalled()
    })

    it('is a no-op for an unknown workspace id', () => {
      const emitSpy = vi.mocked(window.pine.lifecycle.emit)

      useWorkspacesStore.getState().setState('does-not-exist', 'done')

      expect(emitSpy).not.toHaveBeenCalled()
    })
  })

  describe('nameFromWorkDir (via setWorkDir)', () => {
    it('strips a trailing slash: "/foo/bar/" → "bar"', () => {
      const id = open().id

      useWorkspacesStore.getState().setWorkDir(id, '/foo/bar/')

      expect(workspaces().find((s) => s.id === id)?.name).toBe('bar')
    })

    it('maps "~" to "home"', () => {
      const id = open().id
      useWorkspacesStore.getState().setWorkDir(id, '/somewhere/else')
      expect(workspaces().find((s) => s.id === id)?.name).toBe('else')

      useWorkspacesStore.getState().setWorkDir(id, '~')

      expect(workspaces().find((s) => s.id === id)?.name).toBe('home')
    })

    it('falls back to "workspace" for a root path with an empty last segment: "/"', () => {
      const id = open().id

      useWorkspacesStore.getState().setWorkDir(id, '/')

      const updated = workspaces().find((s) => s.id === id)
      expect(updated?.workDir).toBe('/')
      expect(updated?.name).toBe('workspace')
    })
  })

  describe('hydrate', () => {
    const snapshotOf = (
      ids: string[],
      activeWorkspaceId: string | null = ids[0] ?? null,
    ): AppSnapshot => ({
      v: 1,
      savedAt: '2026-08-06T00:00:00.000Z',
      activeWorkspaceId,
      workspaces: ids.map((id) => ({
        id,
        name: `proj-${id}`,
        kind: 'terminal' as const,
        workDir: `/w/${id}`,
        activePaneId: `pane-${id}`,
        root: {
          type: 'pane' as const,
          id: `pane-${id}`,
          title: 'zsh',
          kind: 'terminal' as const,
          cwd: `/w/${id}`,
        },
      })),
    })

    it('restores the saved workspaces', () => {
      useWorkspacesStore.getState().hydrate(snapshotOf(['w40', 'w41']))

      expect(workspaces().map((s) => s.id)).toEqual(['w40', 'w41'])
      expect(workspaces().map((s) => s.workDir)).toEqual(['/w/w40', '/w/w41'])
      expect(workspaces().map((s) => s.name)).toEqual(['proj-w40', 'proj-w41'])
    })

    it('restores every workspace as idle — a live state is never carried across a restart', () => {
      useWorkspacesStore.getState().hydrate(snapshotOf(['w40', 'w41']))
      expect(workspaces().every((s) => s.state === 'idle')).toBe(true)
    })

    it('focuses the workspace that was active when the snapshot was written', () => {
      useWorkspacesStore.getState().hydrate(snapshotOf(['w40', 'w41'], 'w41'))
      expect(activeId()).toBe('w41')
    })

    it('hands the restored layouts to layoutStore', () => {
      useWorkspacesStore.getState().hydrate(snapshotOf(['w40']))

      const hydrate = vi.mocked(useLayoutStore.getState().hydrate)
      expect(hydrate).toHaveBeenCalledTimes(1)
      const layouts = hydrate.mock.calls[0][0]
      expect(Object.keys(layouts)).toEqual(['w40'])
      expect(layouts.w40).toMatchObject({ activePaneId: 'pane-w40', zoomedPaneId: null })
    })

    it('announces each restored workspace to main so it can resolve their workDirs', () => {
      useWorkspacesStore.getState().hydrate(snapshotOf(['w40', 'w41']))

      const emitted = vi.mocked(window.pine.lifecycle.emit).mock.calls.map((c) => c[0])
      expect(emitted).toContainEqual({
        type: 'workspace-added',
        workspaceId: 'w40',
        workDir: '/w/w40',
      })
      expect(emitted).toContainEqual({
        type: 'workspace-added',
        workspaceId: 'w41',
        workDir: '/w/w41',
      })
    })

    it('reserves restored workspace ids so a newly opened workspace cannot collide', () => {
      useWorkspacesStore.getState().hydrate(snapshotOf(['w40', 'w41']))

      useWorkspacesStore.getState().addWorkspace('/tmp')

      const ids = workspaces().map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.slice(0, 2)).toEqual(['w40', 'w41'])
    })

    it('creates no workspace when there is nothing to restore', () => {
      useWorkspacesStore.getState().hydrate(null)

      expect(workspaces()).toEqual([])
      expect(activeId()).toBeNull()
      expect(ensureMock()).not.toHaveBeenCalled()
      expect(window.pine.lifecycle.emit).not.toHaveBeenCalled()
    })

    it('restores an empty saved workspace as zero workspaces', () => {
      useWorkspacesStore.getState().hydrate(snapshotOf([], null))

      expect(workspaces()).toEqual([])
      expect(activeId()).toBeNull()
      expect(ensureMock()).not.toHaveBeenCalled()
    })

    it('adopts restored ids even when the new workspace is opened after closing them all', () => {
      useWorkspacesStore.getState().hydrate(snapshotOf(['w70']))
      useWorkspacesStore.getState().closeWorkspace('w70')

      const next = open()

      expect(Number(next.id.slice(1))).toBeGreaterThan(70)
    })
  })

  describe('rename', () => {
    it('shows a name the user chose and clears it with an empty name', () => {
      const w = open('/home/me/app')
      useWorkspacesStore.getState().rename(w.id, '  payments  ')
      expect(workspaces()[0].customName).toBe('payments')
      useWorkspacesStore.getState().setWorkDir(w.id, '/home/me/other')
      expect(workspaces()[0]).toMatchObject({ customName: 'payments', name: 'other' })
      useWorkspacesStore.getState().rename(w.id, ' ')
      expect(workspaces()[0].customName).toBeUndefined()
    })
  })

  describe('cmux-style row actions', () => {
    const store = () => useWorkspacesStore.getState()

    it('sets, trims and clears a description', () => {
      const w = open('/a')
      store().describe(w.id, '  PR #512: fix refunds  ')
      expect(workspaces()[0].description).toBe('PR #512: fix refunds')
      store().describe(w.id, ' ')
      expect(workspaces()[0].description).toBeUndefined()
    })

    it('pins to the top and moves only within its group', () => {
      const a = open('/a')
      const b = open('/b')
      const c = open('/c')
      store().setPinned(c.id, true)
      expect(workspaces().map((w) => w.id)).toEqual([c.id, a.id, b.id])
      store().moveBy(a.id, -1)
      expect(workspaces().map((w) => w.id)).toEqual([c.id, a.id, b.id])
      store().moveBy(b.id, -1)
      expect(workspaces().map((w) => w.id)).toEqual([c.id, b.id, a.id])
    })

    it('closes every other workspace and keeps this one active', () => {
      const a = open('/a')
      open('/b')
      open('/c')
      store().closeOthers(a.id)
      expect(workspaces().map((w) => w.id)).toEqual([a.id])
      expect(activeId()).toBe(a.id)
    })
  })
})
