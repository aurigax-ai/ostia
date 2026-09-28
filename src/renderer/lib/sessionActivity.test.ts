import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetIds } from '../layout/tree'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import {
  NOTIFY_AFTER_MS,
  isPaneViewed,
  isPaneVisible,
  jumpToLatestUnread,
  shouldNotifyCommandEnd,
  signalPane,
  startAttentionSync,
  syncSessionState,
} from './sessionActivity'

function homeSessionId(): string {
  if (useSessionsStore.getState().sessions.length === 0) useSessionsStore.getState().addSession()
  return useSessionsStore.getState().sessions[0].id
}

describe('shouldNotifyCommandEnd', () => {
  it('notifies only for long commands while the window is unfocused', () => {
    expect(shouldNotifyCommandEnd(NOTIFY_AFTER_MS, false)).toBe(true)
    expect(shouldNotifyCommandEnd(NOTIFY_AFTER_MS - 1, false)).toBe(false)
    expect(shouldNotifyCommandEnd(NOTIFY_AFTER_MS * 3, true)).toBe(false)
  })
})

describe('session activity + attention', () => {
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let attentionInit: ReturnType<typeof useAttentionStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>

  beforeAll(() => {
    sessionsInit = useSessionsStore.getState()
    layoutInit = useLayoutStore.getState()
    blocksInit = useBlocksStore.getState()
    attentionInit = useAttentionStore.getState()
    uiInit = useUIStore.getState()
  })

  afterEach(() => {
    useSessionsStore.setState(sessionsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useBlocksStore.setState(blocksInit, true)
    useAttentionStore.setState(attentionInit, true)
    useUIStore.setState(uiInit, true)
    resetIds()
    vi.restoreAllMocks()
  })

  const setup = (): { sessionId: string; panes: string[] } => {
    const sessionId = homeSessionId()
    useLayoutStore.getState().ensure(sessionId)
    const first = useLayoutStore.getState().bySession[sessionId].activePaneId
    useLayoutStore.getState().split(sessionId, first, 'horizontal')
    const layout = useLayoutStore.getState().bySession[sessionId]
    const panes = [first, layout.activePaneId].filter((id, i, all) => all.indexOf(id) === i)
    return { sessionId, panes }
  }
  const stateOf = (id: string) =>
    useSessionsStore.getState().sessions.find((s) => s.id === id)?.state

  it('treats a background tab as not visible, and brings it forward when it is revealed', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const sessionId = homeSessionId()
    useLayoutStore.getState().ensure(sessionId)
    const first = useLayoutStore.getState().bySession[sessionId].activePaneId
    const second = useLayoutStore.getState().newTab(sessionId, first, 'terminal') as string

    expect(isPaneVisible(second)).toBe(true)
    expect(isPaneVisible(first)).toBe(false)

    signalPane(first, { type: 'set', state: 'waiting', at: 1 })
    expect(useAttentionStore.getState().byPane[first]?.unread).toBe(true)

    expect(jumpToLatestUnread()).toBe(first)
    expect(isPaneVisible(first)).toBe(true)
    expect(isPaneVisible(second)).toBe(false)
  })

  it('keeps attention sync quiet with zero sessions, then tracks the first session opened', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const stop = startAttentionSync()
    window.dispatchEvent(new Event('focus'))
    expect(isPaneViewed('pane-1')).toBe(false)
    expect(jumpToLatestUnread()).toBeNull()

    useSessionsStore.getState().addSession()
    const sessionId = homeSessionId()
    const paneId = useLayoutStore.getState().bySession[sessionId].activePaneId
    useSessionsStore.getState().closeSession(sessionId)
    stop()

    expect(useSessionsStore.getState().sessions).toEqual([])
    expect(useAttentionStore.getState().byPane[paneId]).toBeUndefined()
  })

  it('marks the session working while any of its panes runs, idle when all finish', () => {
    const { sessionId, panes } = setup()
    expect(panes).toHaveLength(2)
    const [a, b] = panes
    const blocks = () => useBlocksStore.getState()

    blocks().commandStart(a, { line: 1 })
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('working')

    blocks().commandStart(b, { line: 1 })
    blocks().commandEnd(a, { line: 3 }, 0)
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('working')

    blocks().commandEnd(b, { line: 4 }, 1)
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('idle')
  })

  it('returns to idle when the pane running a command is dropped', () => {
    const { sessionId, panes } = setup()
    useBlocksStore.getState().commandStart(panes[1], { line: 1 })
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('working')

    useBlocksStore.getState().dropPane(panes[1])
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('idle')
  })

  it('ignores running panes that belong to another session', () => {
    const { sessionId } = setup()
    useBlocksStore.getState().commandStart('elsewhere', { line: 1 })
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('idle')
  })

  const attentionOf = (id: string) => useAttentionStore.getState().byPane[id]
  const focusWindow = (focused: boolean) => vi.spyOn(document, 'hasFocus').mockReturnValue(focused)

  it('reports waiting for the session when an unfocused pane asks for input', () => {
    const { sessionId, panes } = setup()
    focusWindow(true)
    const [a, b] = panes
    useLayoutStore.getState().focusPane(sessionId, b)
    useBlocksStore.getState().commandStart(b, { line: 1 })
    signalPane(a, { type: 'set', state: 'waiting', message: 'approve?', at: 1 })
    syncSessionState(sessionId)
    expect(stateOf(sessionId)).toBe('waiting')
    expect(attentionOf(a)).toMatchObject({ state: 'waiting', unread: true, message: 'approve?' })
  })

  it('applies the view immediately when the signalled pane is the one being looked at', () => {
    const { sessionId, panes } = setup()
    focusWindow(true)
    const active = useLayoutStore.getState().bySession[sessionId].activePaneId
    expect(isPaneViewed(active)).toBe(true)
    signalPane(active, { type: 'set', state: 'done', at: 1 })
    expect(attentionOf(active)).toMatchObject({ state: 'none', unread: false })
    const other = panes.find((p) => p !== active) ?? ''
    expect(isPaneViewed(other)).toBe(false)
  })

  it('treats every pane as unviewed while the window is unfocused', () => {
    const { sessionId } = setup()
    focusWindow(false)
    const active = useLayoutStore.getState().bySession[sessionId].activePaneId
    signalPane(active, { type: 'set', state: 'done', at: 1 })
    expect(attentionOf(active)).toMatchObject({ state: 'done', unread: true })
  })

  it('jumps to the most recent unread pane across sessions and clears it', () => {
    const { sessionId, panes } = setup()
    focusWindow(false)
    useSessionsStore.getState().addSession('/tmp/other')
    const other = useSessionsStore.getState().activeSessionId
    expect(other).not.toBe(sessionId)
    const [a, b] = panes
    signalPane(a, { type: 'notify', message: 'older', waiting: true, at: 1 })
    signalPane(b, { type: 'notify', message: 'newer', waiting: true, at: 2 })
    useUIStore.getState().openSettings()

    expect(jumpToLatestUnread()).toBe(b)
    expect(useSessionsStore.getState().activeSessionId).toBe(sessionId)
    expect(useLayoutStore.getState().bySession[sessionId].activePaneId).toBe(b)
    expect(useUIStore.getState().settingsActive).toBe(false)
    expect(attentionOf(b)).toMatchObject({ state: 'waiting', unread: false })
    expect(attentionOf(a).unread).toBe(true)

    expect(jumpToLatestUnread()).toBe(a)
    expect(jumpToLatestUnread()).toBeNull()
  })

  it('keeps session state in sync and prunes closed panes once wired', () => {
    const { sessionId, panes } = setup()
    focusWindow(false)
    const stop = startAttentionSync()
    try {
      const [a, b] = panes
      useAttentionStore.getState().dispatch(b, { type: 'set', state: 'error', at: 1 })
      expect(stateOf(sessionId)).toBe('error')
      useBlocksStore.getState().commandStart(a, { line: 1 })
      expect(stateOf(sessionId)).toBe('error')
      useLayoutStore.getState().closePane(sessionId, b)
      expect(attentionOf(b)).toBeUndefined()
      expect(stateOf(sessionId)).toBe('working')
    } finally {
      stop()
    }
  })

  it('marks the active pane viewed when the user switches back to its session', () => {
    const { sessionId, panes } = setup()
    focusWindow(false)
    const stop = startAttentionSync()
    try {
      const active = useLayoutStore.getState().bySession[sessionId].activePaneId
      signalPane(active, { type: 'set', state: 'done', at: 1 })
      useSessionsStore.getState().addSession('/tmp/x')
      focusWindow(true)
      useSessionsStore.getState().setActive(sessionId)
      expect(attentionOf(active)).toMatchObject({ state: 'none', unread: false })
      expect(panes).toContain(active)
    } finally {
      stop()
    }
  })
})
