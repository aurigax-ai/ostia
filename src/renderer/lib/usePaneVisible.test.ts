import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resetIds } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { usePaneVisible } from './usePaneVisible'

describe('usePaneVisible', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useUIStore.setState(uiInit, true)
    resetIds()
  })

  it('follows the pane through background tabs, other workspaces and the dashboard', () => {
    useWorkspacesStore.getState().addWorkspace()
    const workspaceId = useWorkspacesStore.getState().workspaces[0].id
    useLayoutStore.getState().ensure(workspaceId)
    const pane = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    const { result, unmount } = renderHook(() => usePaneVisible(pane))
    expect(result.current).toBe(true)

    act(() => {
      useLayoutStore.getState().newTab(workspaceId, pane, 'terminal')
    })
    expect(result.current).toBe(false)

    act(() => useLayoutStore.getState().focusPane(workspaceId, pane))
    expect(result.current).toBe(true)

    act(() => useUIStore.getState().openDashboard())
    expect(result.current).toBe(false)
    act(() => useUIStore.getState().showWorkspaces())
    expect(result.current).toBe(true)

    act(() => {
      useWorkspacesStore.getState().addWorkspace()
    })
    expect(result.current).toBe(false)
    unmount()
  })
})
