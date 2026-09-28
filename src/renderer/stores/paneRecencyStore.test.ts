import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetIds } from '../layout/tree'
import { useLayoutStore } from './layoutStore'
import { startPaneRecencySync, usePaneRecencyStore } from './paneRecencyStore'
import { useWorkspacesStore } from './workspacesStore'

function homeWorkspaceId(): string {
  if (useWorkspacesStore.getState().workspaces.length === 0)
    useWorkspacesStore.getState().addWorkspace()
  return useWorkspacesStore.getState().workspaces[0].id
}

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let recencyInit: ReturnType<typeof usePaneRecencyStore.getState>

beforeAll(() => {
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
  recencyInit = usePaneRecencyStore.getState()
})

afterEach(() => {
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  usePaneRecencyStore.setState(recencyInit, true)
  resetIds()
  vi.useRealTimers()
})

describe('startPaneRecencySync', () => {
  it('stamps a pane each time it becomes the active pane of its workspace', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const workspaceId = homeWorkspaceId()
    useLayoutStore.getState().ensure(workspaceId)
    const a = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    const stop = startPaneRecencySync()
    expect(usePaneRecencyStore.getState().touchedAt[a]).toBe(1000)

    vi.setSystemTime(2000)
    useLayoutStore.getState().split(workspaceId, a, 'horizontal')
    const b = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    expect(usePaneRecencyStore.getState().touchedAt[b]).toBe(2000)

    vi.setSystemTime(3000)
    useLayoutStore.getState().focusPane(workspaceId, a)
    expect(usePaneRecencyStore.getState().touchedAt[a]).toBe(3000)

    stop()
    vi.setSystemTime(4000)
    useLayoutStore.getState().focusPane(workspaceId, b)
    expect(usePaneRecencyStore.getState().touchedAt[b]).toBe(2000)
  })
})
