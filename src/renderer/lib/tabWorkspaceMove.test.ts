import type { LifecycleEvent } from '@shared/types'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { findPane, paneIds, splitTabOfPane, tabsOfPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { resetWorkspaceIds, useWorkspacesStore } from '../stores/workspacesStore'
import {
  type TabMoveSide,
  moveTabToWorkspace,
  tabMoveRefusal,
  tabMoveTargets,
  workspaceOfTab,
} from './tabWorkspaceMove'

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let sandboxInit: ReturnType<typeof useSandboxStore.getState>

beforeAll(() => {
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
  sandboxInit = useSandboxStore.getState()
})

afterEach(() => {
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  useSandboxStore.setState(sandboxInit, true)
  resetWorkspaceIds()
})

function emitted(): LifecycleEvent[] {
  return vi.mocked(window.ostia.lifecycle.emit).mock.calls.map(([event]) => event)
}

function seed(dir: string, tabs: number): { id: string; panes: string[] } {
  useWorkspacesStore.getState().addWorkspace(dir)
  const id = useWorkspacesStore.getState().activeWorkspaceId as string
  useLayoutStore.getState().ensure(id)
  for (let i = 1; i < tabs; i += 1) {
    const active = useLayoutStore.getState().byWorkspace[id].activePaneId
    useLayoutStore.getState().newTab(id, active, 'terminal')
  }
  return { id, panes: paneIds(useLayoutStore.getState().byWorkspace[id].root) }
}

function rootOf(workspaceId: string) {
  return useLayoutStore.getState().byWorkspace[workspaceId]?.root
}

describe('tabMoveRefusal', () => {
  const side = (over: Partial<TabMoveSide> = {}): TabMoveSide => ({
    id: 'a',
    kind: 'terminal',
    sandboxed: false,
    ...over,
  })
  const terminal = [{ kind: 'terminal' as const }]

  it('allows a terminal tab between two plain workspaces', () => {
    expect(tabMoveRefusal(side(), side({ id: 'b' }), terminal)).toBeNull()
  })

  it('refuses the same workspace and a missing tab', () => {
    expect(tabMoveRefusal(side(), side(), terminal)).toBe('same')
    expect(tabMoveRefusal(side(), side({ id: 'b' }), [])).toBe('unknown')
  })

  it('never moves the manager pane or into the manager workspace', () => {
    expect(tabMoveRefusal(side(), side({ id: 'b' }), [{ kind: 'manager' }])).toBe('manager')
    expect(tabMoveRefusal(side(), side({ id: 'b', kind: 'manager' }), terminal)).toBe('manager')
  })

  it('never moves into or out of a scratch or sandboxed workspace', () => {
    expect(tabMoveRefusal(side({ kind: 'scratch' }), side({ id: 'b' }), terminal)).toBe('scratch')
    expect(tabMoveRefusal(side(), side({ id: 'b', kind: 'scratch' }), terminal)).toBe('scratch')
    expect(tabMoveRefusal(side({ sandboxed: true }), side({ id: 'b' }), terminal)).toBe('sandbox')
    expect(tabMoveRefusal(side(), side({ id: 'b', sandboxed: true }), terminal)).toBe('sandbox')
  })
})

describe('moveTabToWorkspace', () => {
  it('moves a running tab as a new tab of the target, keeping its pane id, without closing it', async () => {
    const source = seed('/home/u/api', 2)
    const target = seed('/home/u/web', 1)
    useWorkspacesStore.getState().setActive(source.id)
    vi.mocked(window.ostia.lifecycle.emit).mockClear()
    const [kept, moving] = source.panes

    expect(await moveTabToWorkspace(source.id, moving, target.id)).toBe(true)

    expect(window.ostia.workspace.movePanes).toHaveBeenCalledWith(
      source.id,
      target.id,
      [moving],
      false,
    )
    expect(paneIds(rootOf(source.id))).toEqual([kept])
    expect(paneIds(rootOf(target.id))).toEqual([...target.panes, moving])
    expect(useLayoutStore.getState().byWorkspace[target.id].activePaneId).toBe(moving)
    expect(useLayoutStore.getState().byWorkspace[source.id].activePaneId).toBe(kept)
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(source.id)
    expect(emitted()).toEqual([])
    expect(workspaceOfTab(moving)).toBe(target.id)
  })

  it('moves a locked pane, since moving is not closing', async () => {
    const source = seed('/home/u/api', 2)
    const target = seed('/home/u/web', 1)
    useLayoutStore.getState().setLocked(source.id, source.panes[1], true)

    expect(await moveTabToWorkspace(source.id, source.panes[1], target.id)).toBe(true)

    expect(findPane(rootOf(target.id), source.panes[1])?.locked).toBe(true)
  })

  it('carries the resume token with the pane', async () => {
    const source = seed('/home/u/api', 2)
    const target = seed('/home/u/web', 1)
    useLayoutStore.getState().setResume(source.id, source.panes[1], { agent: 'claude', id: 'r1' })

    await moveTabToWorkspace(source.id, source.panes[1], target.id)

    expect(findPane(rootOf(target.id), source.panes[1])?.resume).toEqual({
      agent: 'claude',
      id: 'r1',
    })
  })

  it('moves a split-tab segment alone, and the whole split tab by its id', async () => {
    const source = seed('/home/u/api', 2)
    const target = seed('/home/u/web', 1)
    const [first, second] = source.panes
    useLayoutStore.getState().split(source.id, second, 'horizontal')
    const third = useLayoutStore.getState().byWorkspace[source.id].activePaneId
    const split = splitTabOfPane(rootOf(source.id), second)
    if (!split) throw new Error('expected a split tab')

    expect(await moveTabToWorkspace(source.id, third, target.id)).toBe(true)
    expect(paneIds(rootOf(source.id))).toEqual([first, second])
    expect(paneIds(rootOf(target.id))).toEqual([...target.panes, third])

    useLayoutStore.getState().split(source.id, second, 'vertical')
    const fourth = useLayoutStore.getState().byWorkspace[source.id].activePaneId
    const whole = splitTabOfPane(rootOf(source.id), second)
    if (!whole) throw new Error('expected a split tab')
    expect(await moveTabToWorkspace(source.id, whole.id, target.id)).toBe(true)
    expect(paneIds(rootOf(source.id))).toEqual([first])
    expect(splitTabOfPane(rootOf(target.id), fourth)?.id).toBe(whole.id)
    expect(tabsOfPane(rootOf(target.id), fourth)?.children).toHaveLength(3)
  })

  it('moves the workspace when its last tab moves', async () => {
    const source = seed('/home/u/api', 1)
    const target = seed('/home/u/web', 1)
    useWorkspacesStore.getState().setActive(source.id)
    vi.mocked(window.ostia.lifecycle.emit).mockClear()

    expect(await moveTabToWorkspace(source.id, source.panes[0], target.id)).toBe(true)

    expect(window.ostia.workspace.movePanes).toHaveBeenCalledWith(
      source.id,
      target.id,
      source.panes,
      true,
    )
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual([target.id])
    expect(useLayoutStore.getState().byWorkspace[source.id]).toBeUndefined()
    expect(paneIds(rootOf(target.id))).toEqual([...target.panes, ...source.panes])
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(target.id)
    expect(emitted().filter((e) => e.type === 'pane-closed')).toEqual([])
  })

  it('stays put when main refuses', async () => {
    const source = seed('/home/u/api', 2)
    const target = seed('/home/u/web', 1)
    vi.mocked(window.ostia.workspace.movePanes).mockResolvedValueOnce({
      ok: false,
      error: 'sandbox',
    })

    expect(await moveTabToWorkspace(source.id, source.panes[1], target.id)).toBe(false)

    expect(paneIds(rootOf(source.id))).toEqual(source.panes)
    expect(paneIds(rootOf(target.id))).toEqual(target.panes)
  })

  it('refuses a sandboxed side before asking main', async () => {
    const source = seed('/home/u/api', 2)
    const target = seed('/home/u/web', 1)
    useSandboxStore.setState((s) => ({ enabled: { ...s.enabled, [target.id]: true } }))

    expect(await moveTabToWorkspace(source.id, source.panes[1], target.id)).toBe(false)
    expect(window.ostia.workspace.movePanes).not.toHaveBeenCalled()
    expect(tabMoveTargets(source.id, source.panes[1])).toEqual([
      { id: target.id, name: 'web', refusal: 'sandbox' },
    ])
  })
})
