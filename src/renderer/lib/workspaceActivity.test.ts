import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetIds } from '../layout/tree'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { POINTER_VIEW_MS, resetPointerView } from './pointerView'
import {
  isPaneViewed,
  isPaneVisible,
  jumpToLatestUnread,
  paneAttentionChanges,
  shouldNotifyCommandEnd,
  signalPane,
  startAttentionSync,
  syncWorkspaceState,
  usePaneVisible,
  viewPointedPane,
} from './workspaceActivity'

function homeWorkspaceId(): string {
  if (useWorkspacesStore.getState().workspaces.length === 0)
    useWorkspacesStore.getState().addWorkspace()
  return useWorkspacesStore.getState().workspaces[0].id
}

describe('paneAttentionChanges', () => {
  it('lists panes whose state or message changed and skips new panes with no state', () => {
    const working = { state: 'working' as const, unread: false, at: 1 }
    expect(
      paneAttentionChanges(
        {
          a: working,
          b: { state: 'waiting', unread: true, message: 'Allow?', at: 2 },
          c: { state: 'none', unread: true, at: 2 },
          d: { state: 'error', unread: true, at: 2 },
        },
        { a: working, b: { state: 'waiting', unread: true, message: 'Old', at: 1 } },
      ),
    ).toEqual([
      { paneId: 'b', state: 'waiting', message: 'Allow?' },
      { paneId: 'd', state: 'error' },
    ])
  })
})

describe('shouldNotifyCommandEnd', () => {
  it('notifies only for long commands while the window is unfocused', () => {
    expect(shouldNotifyCommandEnd(10_000, false, 10)).toBe(true)
    expect(shouldNotifyCommandEnd(9_999, false, 10)).toBe(false)
    expect(shouldNotifyCommandEnd(30_000, true, 10)).toBe(false)
    expect(shouldNotifyCommandEnd(3_000, false, 3)).toBe(true)
    expect(shouldNotifyCommandEnd(59_000, false, 60)).toBe(false)
  })
})

describe('workspace activity + attention', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let attentionInit: ReturnType<typeof useAttentionStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    blocksInit = useBlocksStore.getState()
    attentionInit = useAttentionStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useBlocksStore.setState(blocksInit, true)
    useAttentionStore.setState(attentionInit, true)
    useUIStore.setState(uiInit, true)
    resetIds()
    resetPointerView()
    vi.restoreAllMocks()
  })

  const setup = (): { workspaceId: string; panes: string[] } => {
    const workspaceId = homeWorkspaceId()
    useLayoutStore.getState().ensure(workspaceId)
    const first = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    useLayoutStore.getState().split(workspaceId, first, 'horizontal')
    const layout = useLayoutStore.getState().byWorkspace[workspaceId]
    const panes = [first, layout.activePaneId].filter((id, i, all) => all.indexOf(id) === i)
    return { workspaceId, panes }
  }
  const stateOf = (id: string) =>
    useWorkspacesStore.getState().workspaces.find((s) => s.id === id)?.state

  it('treats a background tab as not visible, and brings it forward when it is revealed', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const workspaceId = homeWorkspaceId()
    useLayoutStore.getState().ensure(workspaceId)
    const first = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    const second = useLayoutStore.getState().newTab(workspaceId, first, 'terminal') as string

    expect(isPaneVisible(second)).toBe(true)
    expect(isPaneVisible(first)).toBe(false)

    signalPane(first, { type: 'set', state: 'waiting', at: 1 })
    expect(useAttentionStore.getState().byPane[first]?.unread).toBe(true)

    expect(jumpToLatestUnread()).toBe(first)
    expect(isPaneVisible(first)).toBe(true)
    expect(isPaneVisible(second)).toBe(false)
  })

  it('re-renders a pane hook when its tab or the dashboard hides or shows it', () => {
    const workspaceId = homeWorkspaceId()
    useLayoutStore.getState().ensure(workspaceId)
    const first = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    const { result, unmount } = renderHook(() => usePaneVisible(first))
    expect(result.current).toBe(true)

    const second = act(() => useLayoutStore.getState().newTab(workspaceId, first, 'terminal'))
    expect(second).toBeTruthy()
    expect(result.current).toBe(false)

    act(() => useLayoutStore.getState().focusPane(workspaceId, first))
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

  it('treats panes as not viewed while the dashboard covers them, and views the active one after', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const stop = startAttentionSync()
    const workspaceId = homeWorkspaceId()
    useLayoutStore.getState().ensure(workspaceId)
    const pane = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    expect(isPaneViewed(pane)).toBe(true)

    useUIStore.getState().openDashboard()
    expect(isPaneVisible(pane)).toBe(false)
    signalPane(pane, { type: 'notify', message: 'build finished', waiting: false, at: 1 })
    expect(useAttentionStore.getState().byPane[pane]?.unread).toBe(true)

    useUIStore.getState().showWorkspaces()
    expect(useAttentionStore.getState().byPane[pane]?.unread).toBe(false)
    stop()
  })

  it('tells main every state a pane passes through, even done that viewing clears at once', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const stop = startAttentionSync()
    const workspaceId = homeWorkspaceId()
    useLayoutStore.getState().ensure(workspaceId)
    const pane = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    const emit = vi.mocked(window.ostia.lifecycle.emit)
    emit.mockClear()
    signalPane(pane, { type: 'set', state: 'done', message: 'tests pass', at: 1 })
    stop()
    const reports = emit.mock.calls
      .map(([event]) => event)
      .filter((e) => e.type === 'pane-attention')
    expect(reports).toEqual([
      { type: 'pane-attention', paneId: pane, state: 'done', message: 'tests pass' },
      { type: 'pane-attention', paneId: pane, state: 'none', message: 'tests pass' },
    ])
  })

  it('keeps attention sync quiet with zero workspaces, then tracks the first workspace opened', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const stop = startAttentionSync()
    window.dispatchEvent(new Event('focus'))
    expect(isPaneViewed('pane-1')).toBe(false)
    expect(jumpToLatestUnread()).toBeNull()

    useWorkspacesStore.getState().addWorkspace()
    const workspaceId = homeWorkspaceId()
    useLayoutStore.getState().ensure(workspaceId)
    const paneId = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    useWorkspacesStore.getState().closeWorkspace(workspaceId)
    stop()

    expect(useWorkspacesStore.getState().workspaces).toEqual([])
    expect(useAttentionStore.getState().byPane[paneId]).toBeUndefined()
  })

  it('marks the workspace working while any of its panes runs, idle when all finish', () => {
    const { workspaceId, panes } = setup()
    expect(panes).toHaveLength(2)
    const [a, b] = panes
    const blocks = () => useBlocksStore.getState()

    blocks().commandStart(a, { line: 1 })
    syncWorkspaceState(workspaceId)
    expect(stateOf(workspaceId)).toBe('working')

    blocks().commandStart(b, { line: 1 })
    blocks().commandEnd(a, { line: 3 }, 0)
    syncWorkspaceState(workspaceId)
    expect(stateOf(workspaceId)).toBe('working')

    blocks().commandEnd(b, { line: 4 }, 1)
    syncWorkspaceState(workspaceId)
    expect(stateOf(workspaceId)).toBe('idle')
  })

  it('returns to idle when the pane running a command is dropped', () => {
    const { workspaceId, panes } = setup()
    useBlocksStore.getState().commandStart(panes[1], { line: 1 })
    syncWorkspaceState(workspaceId)
    expect(stateOf(workspaceId)).toBe('working')

    useBlocksStore.getState().dropPane(panes[1])
    syncWorkspaceState(workspaceId)
    expect(stateOf(workspaceId)).toBe('idle')
  })

  it('ignores running panes that belong to another workspace', () => {
    const { workspaceId } = setup()
    useBlocksStore.getState().commandStart('elsewhere', { line: 1 })
    syncWorkspaceState(workspaceId)
    expect(stateOf(workspaceId)).toBe('idle')
  })

  const attentionOf = (id: string) => useAttentionStore.getState().byPane[id]
  const focusWindow = (focused: boolean) => vi.spyOn(document, 'hasFocus').mockReturnValue(focused)

  it('reports waiting for the workspace when an unfocused pane asks for input', () => {
    const { workspaceId, panes } = setup()
    focusWindow(true)
    const [a, b] = panes
    useLayoutStore.getState().focusPane(workspaceId, b)
    useBlocksStore.getState().commandStart(b, { line: 1 })
    signalPane(a, { type: 'set', state: 'waiting', message: 'approve?', at: 1 })
    syncWorkspaceState(workspaceId)
    expect(stateOf(workspaceId)).toBe('waiting')
    expect(attentionOf(a)).toMatchObject({ state: 'waiting', unread: true, message: 'approve?' })
  })

  it('applies the view immediately when the signalled pane is the one being looked at', () => {
    const { workspaceId, panes } = setup()
    focusWindow(true)
    const active = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    expect(isPaneViewed(active)).toBe(true)
    signalPane(active, { type: 'set', state: 'done', at: 1 })
    expect(attentionOf(active)).toMatchObject({ state: 'none', unread: false })
    const other = panes.find((p) => p !== active) ?? ''
    expect(isPaneViewed(other)).toBe(false)
  })

  it('treats every pane as unviewed while the window is unfocused', () => {
    const { workspaceId } = setup()
    focusWindow(false)
    const active = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    signalPane(active, { type: 'set', state: 'done', at: 1 })
    expect(attentionOf(active)).toMatchObject({ state: 'done', unread: true })
  })

  it('jumps to the most recent unread pane across workspaces and clears it', () => {
    const { workspaceId, panes } = setup()
    focusWindow(false)
    useWorkspacesStore.getState().addWorkspace('/tmp/other')
    const other = useWorkspacesStore.getState().activeWorkspaceId
    expect(other).not.toBe(workspaceId)
    const [a, b] = panes
    signalPane(a, { type: 'notify', message: 'older', waiting: true, at: 1 })
    signalPane(b, { type: 'notify', message: 'newer', waiting: true, at: 2 })
    useUIStore.getState().openSettings()

    expect(jumpToLatestUnread()).toBe(b)
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(workspaceId)
    expect(useLayoutStore.getState().byWorkspace[workspaceId].activePaneId).toBe(b)
    expect(useUIStore.getState().settingsActive).toBe(false)
    expect(attentionOf(b)).toMatchObject({ state: 'waiting', unread: false })
    expect(attentionOf(a).unread).toBe(true)

    expect(jumpToLatestUnread()).toBe(a)
    expect(jumpToLatestUnread()).toBeNull()
  })

  it('keeps workspace state in sync and prunes closed panes once wired', () => {
    const { workspaceId, panes } = setup()
    focusWindow(false)
    const stop = startAttentionSync()
    try {
      const [a, b] = panes
      useAttentionStore.getState().dispatch(b, { type: 'set', state: 'error', at: 1 })
      expect(stateOf(workspaceId)).toBe('error')
      useBlocksStore.getState().commandStart(a, { line: 1 })
      expect(stateOf(workspaceId)).toBe('error')
      useLayoutStore.getState().closePane(workspaceId, b)
      expect(attentionOf(b)).toBeUndefined()
      expect(stateOf(workspaceId)).toBe('working')
    } finally {
      stop()
    }
  })

  it('marks the active pane viewed when the user switches back to its workspace', () => {
    const { workspaceId, panes } = setup()
    focusWindow(false)
    const stop = startAttentionSync()
    try {
      const active = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
      signalPane(active, { type: 'set', state: 'done', at: 1 })
      useWorkspacesStore.getState().addWorkspace('/tmp/x')
      focusWindow(true)
      useWorkspacesStore.getState().setActive(workspaceId)
      expect(attentionOf(active)).toMatchObject({ state: 'none', unread: false })
      expect(panes).toContain(active)
    } finally {
      stop()
    }
  })

  it('clears unread on a visible background pane the pointer reaches while the window is focused', () => {
    const { workspaceId, panes } = setup()
    focusWindow(false)
    const active = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    const unfocused = panes.find((p) => p !== active) ?? ''
    signalPane(unfocused, { type: 'set', state: 'done', at: 1 })
    expect(attentionOf(unfocused).unread).toBe(true)
    viewPointedPane(unfocused)
    expect(attentionOf(unfocused).unread).toBe(true)
    focusWindow(true)
    viewPointedPane(unfocused)
    expect(attentionOf(unfocused)).toMatchObject({ state: 'none', unread: false })
  })

  it('keeps unread on a pane in a background tab even when the pointer is reported over it', () => {
    focusWindow(true)
    const workspaceId = homeWorkspaceId()
    useLayoutStore.getState().ensure(workspaceId)
    const first = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    useLayoutStore.getState().newTab(workspaceId, first, 'terminal')
    expect(isPaneVisible(first)).toBe(false)
    signalPane(first, { type: 'set', state: 'done', at: 1 })
    viewPointedPane(first)
    expect(attentionOf(first)).toMatchObject({ state: 'done', unread: true })
  })

  it('counts a pointed-at pane as viewed for exactly the pointer window', () => {
    const { workspaceId, panes } = setup()
    focusWindow(true)
    const active = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
    const other = panes.find((p) => p !== active) ?? ''
    const now = vi.spyOn(Date, 'now').mockReturnValue(50_000)
    viewPointedPane(other)
    now.mockReturnValue(50_000 + POINTER_VIEW_MS)
    signalPane(other, { type: 'set', state: 'done', at: 1 })
    expect(attentionOf(other)).toMatchObject({ state: 'none', unread: false })
    now.mockReturnValue(50_001 + POINTER_VIEW_MS)
    signalPane(other, { type: 'set', state: 'done', at: 2 })
    expect(attentionOf(other)).toMatchObject({ state: 'done', unread: true })
  })
})
