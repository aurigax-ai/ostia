import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetIds } from '../layout/tree'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import {
  NOTIFY_AFTER_MS,
  isPaneViewed,
  isPaneVisible,
  jumpToLatestUnread,
  shouldNotifyCommandEnd,
  signalPane,
  startAttentionSync,
  syncWorkspaceState,
} from './workspaceActivity'

function homeWorkspaceId(): string {
  if (useWorkspacesStore.getState().workspaces.length === 0)
    useWorkspacesStore.getState().addWorkspace()
  return useWorkspacesStore.getState().workspaces[0].id
}

describe('shouldNotifyCommandEnd', () => {
  it('notifies only for long commands while the window is unfocused', () => {
    expect(shouldNotifyCommandEnd(NOTIFY_AFTER_MS, false)).toBe(true)
    expect(shouldNotifyCommandEnd(NOTIFY_AFTER_MS - 1, false)).toBe(false)
    expect(shouldNotifyCommandEnd(NOTIFY_AFTER_MS * 3, true)).toBe(false)
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
})
