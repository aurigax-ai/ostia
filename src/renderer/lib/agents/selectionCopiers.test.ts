import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import {
  copyActivePaneSelection,
  copyPaneSelection,
  registerSelectionCopier,
} from './selectionCopiers'

const layoutBefore = useLayoutStore.getState()
const workspacesBefore = useWorkspacesStore.getState()

beforeEach(() => {
  useWorkspacesStore.setState({ activeWorkspaceId: 'w1' })
  useLayoutStore.setState({
    byWorkspace: { w1: { activePaneId: 'p1' } as never },
  })
})

afterEach(() => {
  useLayoutStore.setState(layoutBefore, true)
  useWorkspacesStore.setState(workspacesBefore, true)
})

describe('selection copiers', () => {
  it('runs the registered copier and reports it took the copy', () => {
    const copy = vi.fn(() => Promise.resolve())
    const off = registerSelectionCopier('p1', copy)
    expect(copyPaneSelection('p1')).toBe(true)
    expect(copy).toHaveBeenCalledTimes(1)
    off()
    expect(copyPaneSelection('p1')).toBe(false)
  })

  it('falls through when the pane has no copier or the copier has nothing', () => {
    expect(copyPaneSelection('p1')).toBe(false)
    const off = registerSelectionCopier('p1', () => null)
    expect(copyPaneSelection('p1')).toBe(false)
    off()
  })

  it('asks only the active pane', () => {
    const other = vi.fn(() => Promise.resolve())
    const mine = vi.fn(() => Promise.resolve())
    const offOther = registerSelectionCopier('p2', other)
    const offMine = registerSelectionCopier('p1', mine)
    expect(copyActivePaneSelection()).toBe(true)
    expect(mine).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    offOther()
    offMine()
  })

  it('keeps a newer copier when an older one unregisters late', () => {
    const first = vi.fn(() => Promise.resolve())
    const second = vi.fn(() => Promise.resolve())
    const offFirst = registerSelectionCopier('p1', first)
    const offSecond = registerSelectionCopier('p1', second)
    offFirst()
    expect(copyPaneSelection('p1')).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    offSecond()
  })

  it('has no active pane to ask when no workspace is open', () => {
    useWorkspacesStore.setState({ activeWorkspaceId: null })
    expect(copyActivePaneSelection()).toBe(false)
  })
})
