import { findPane, paneIds } from '../layout/tree'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { focusSurface } from '../stores/surfaceSlotsStore'
import { useUIStore } from '../stores/uiStore'
import {
  type AttentionEvent,
  aggregateSessionState,
  latestUnread,
  paneLiveState,
} from './attention'

export const NOTIFY_AFTER_MS = 10_000

export function shouldNotifyCommandEnd(durationMs: number, windowFocused: boolean): boolean {
  return !windowFocused && durationMs >= NOTIFY_AFTER_MS
}

export function sessionOfPane(paneId: string): string | null {
  for (const [sessionId, layout] of Object.entries(useLayoutStore.getState().bySession)) {
    if (layout && findPane(layout.root, paneId)) return sessionId
  }
  return null
}

export function isPaneVisible(paneId: string): boolean {
  const sessionId = sessionOfPane(paneId)
  if (!sessionId || sessionId !== useSessionsStore.getState().activeSessionId) return false
  if (useUIStore.getState().settingsActive) return false
  const zoomed = useLayoutStore.getState().bySession[sessionId]?.zoomedPaneId
  return !zoomed || zoomed === paneId
}

export function isPaneViewed(paneId: string): boolean {
  if (!document.hasFocus() || !isPaneVisible(paneId)) return false
  const sessionId = useSessionsStore.getState().activeSessionId
  return useLayoutStore.getState().bySession[sessionId]?.activePaneId === paneId
}

export function signalPane(paneId: string, event: AttentionEvent): void {
  const store = useAttentionStore.getState()
  store.dispatch(paneId, event)
  if (isPaneViewed(paneId)) store.dispatch(paneId, { type: 'view', at: event.at })
}

export function syncSessionState(sessionId: string): void {
  const sessions = useSessionsStore.getState()
  if (!sessions.sessions.some((s) => s.id === sessionId)) return
  const layout = useLayoutStore.getState().bySession[sessionId]
  const running = useBlocksStore.getState().running
  const attention = useAttentionStore.getState().byPane
  const states = layout
    ? paneIds(layout.root).map((id) => paneLiveState(attention[id], running[id] !== undefined))
    : []
  sessions.setState(sessionId, aggregateSessionState(states))
}

export function syncAllSessionStates(): void {
  for (const s of useSessionsStore.getState().sessions) syncSessionState(s.id)
}

export function viewActivePane(): void {
  if (!document.hasFocus() || useUIStore.getState().settingsActive) return
  const sessionId = useSessionsStore.getState().activeSessionId
  const paneId = useLayoutStore.getState().bySession[sessionId]?.activePaneId
  if (paneId) useAttentionStore.getState().dispatch(paneId, { type: 'view', at: Date.now() })
}

export function revealPane(paneId: string): boolean {
  const sessionId = sessionOfPane(paneId)
  if (!sessionId) return false
  useUIStore.getState().leaveSettings()
  if (useSessionsStore.getState().activeSessionId !== sessionId) {
    useSessionsStore.getState().setActive(sessionId)
  }
  const layout = useLayoutStore.getState().bySession[sessionId]
  if (layout?.zoomedPaneId && layout.zoomedPaneId !== paneId) {
    useLayoutStore.getState().zoomPane(sessionId, layout.zoomedPaneId, false)
  }
  useLayoutStore.getState().focusPane(sessionId, paneId)
  useAttentionStore.getState().dispatch(paneId, { type: 'view', at: Date.now() })
  requestAnimationFrame(() => focusSurface(paneId))
  return true
}

export function allPaneIds(): string[] {
  const ids: string[] = []
  for (const layout of Object.values(useLayoutStore.getState().bySession)) {
    if (layout) ids.push(...paneIds(layout.root))
  }
  return ids
}

export function jumpToLatestUnread(): string | null {
  const target = latestUnread(useAttentionStore.getState().byPane, allPaneIds())
  if (!target) return null
  return revealPane(target) ? target : null
}

export function startAttentionSync(): () => void {
  const offAttention = useAttentionStore.subscribe((s, prev) => {
    if (s.byPane !== prev.byPane) syncAllSessionStates()
  })
  const offBlocks = useBlocksStore.subscribe((s, prev) => {
    if (s.running !== prev.running) syncAllSessionStates()
  })
  const offLayout = useLayoutStore.subscribe((s, prev) => {
    if (s.bySession === prev.bySession) return
    const live = new Set(allPaneIds())
    for (const id of Object.keys(useAttentionStore.getState().byPane)) {
      if (!live.has(id)) useAttentionStore.getState().dropPane(id)
    }
    syncAllSessionStates()
    viewActivePane()
  })
  const offSessions = useSessionsStore.subscribe((s, prev) => {
    if (s.activeSessionId !== prev.activeSessionId) viewActivePane()
  })
  const offUi = useUIStore.subscribe((s, prev) => {
    if (s.settingsActive !== prev.settingsActive) viewActivePane()
  })
  window.addEventListener('focus', viewActivePane)
  syncAllSessionStates()
  return () => {
    offAttention()
    offBlocks()
    offLayout()
    offSessions()
    offUi()
    window.removeEventListener('focus', viewActivePane)
  }
}
