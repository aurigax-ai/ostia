import { findPane, isPaneShown, paneIds } from '../layout/tree'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { focusSurface } from '../stores/surfaceSlotsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import {
  type AttentionEvent,
  aggregateWorkspaceState,
  latestUnread,
  paneLiveState,
} from './attention'

export const NOTIFY_AFTER_MS = 10_000

export function shouldNotifyCommandEnd(durationMs: number, windowFocused: boolean): boolean {
  return !windowFocused && durationMs >= NOTIFY_AFTER_MS
}

export function workspaceOfPane(paneId: string): string | null {
  for (const [workspaceId, layout] of Object.entries(useLayoutStore.getState().byWorkspace)) {
    if (layout && findPane(layout.root, paneId)) return workspaceId
  }
  return null
}

export function isPaneVisible(paneId: string): boolean {
  const workspaceId = workspaceOfPane(paneId)
  if (!workspaceId || workspaceId !== useWorkspacesStore.getState().activeWorkspaceId) return false
  if (useUIStore.getState().settingsActive) return false
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  if (!layout) return false
  if (layout.zoomedPaneId) return layout.zoomedPaneId === paneId
  return isPaneShown(layout.root, paneId)
}

export function isPaneViewed(paneId: string): boolean {
  if (!document.hasFocus() || !isPaneVisible(paneId)) return false
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  return (
    !!workspaceId && useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId === paneId
  )
}

export function signalPane(paneId: string, event: AttentionEvent): void {
  const store = useAttentionStore.getState()
  store.dispatch(paneId, event)
  if (isPaneViewed(paneId)) store.dispatch(paneId, { type: 'view', at: event.at })
}

export function syncWorkspaceState(workspaceId: string): void {
  const workspaces = useWorkspacesStore.getState()
  if (!workspaces.workspaces.some((s) => s.id === workspaceId)) return
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const running = useBlocksStore.getState().running
  const attention = useAttentionStore.getState().byPane
  const states = layout
    ? paneIds(layout.root).map((id) => paneLiveState(attention[id], running[id] !== undefined))
    : []
  workspaces.setState(workspaceId, aggregateWorkspaceState(states))
}

export function syncAllWorkspaceStates(): void {
  for (const s of useWorkspacesStore.getState().workspaces) syncWorkspaceState(s.id)
}

export function viewActivePane(): void {
  if (!document.hasFocus() || useUIStore.getState().settingsActive) return
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (!workspaceId) return
  const paneId = useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
  if (paneId) useAttentionStore.getState().dispatch(paneId, { type: 'view', at: Date.now() })
}

export function revealPane(paneId: string): boolean {
  const workspaceId = workspaceOfPane(paneId)
  if (!workspaceId) return false
  useUIStore.getState().leaveSettings()
  if (useWorkspacesStore.getState().activeWorkspaceId !== workspaceId) {
    useWorkspacesStore.getState().setActive(workspaceId)
  }
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  if (layout?.zoomedPaneId && layout.zoomedPaneId !== paneId) {
    useLayoutStore.getState().zoomPane(workspaceId, layout.zoomedPaneId, false)
  }
  useLayoutStore.getState().focusPane(workspaceId, paneId)
  useAttentionStore.getState().dispatch(paneId, { type: 'view', at: Date.now() })
  requestAnimationFrame(() => focusSurface(paneId))
  return true
}

export function allPaneIds(): string[] {
  const ids: string[] = []
  for (const layout of Object.values(useLayoutStore.getState().byWorkspace)) {
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
    if (s.byPane !== prev.byPane) syncAllWorkspaceStates()
  })
  const offBlocks = useBlocksStore.subscribe((s, prev) => {
    if (s.running !== prev.running) syncAllWorkspaceStates()
  })
  const offLayout = useLayoutStore.subscribe((s, prev) => {
    if (s.byWorkspace === prev.byWorkspace) return
    const live = new Set(allPaneIds())
    for (const id of Object.keys(useAttentionStore.getState().byPane)) {
      if (!live.has(id)) useAttentionStore.getState().dropPane(id)
    }
    syncAllWorkspaceStates()
    viewActivePane()
  })
  const offWorkspaces = useWorkspacesStore.subscribe((s, prev) => {
    if (s.activeWorkspaceId !== prev.activeWorkspaceId) viewActivePane()
  })
  const offUi = useUIStore.subscribe((s, prev) => {
    if (s.settingsActive !== prev.settingsActive) viewActivePane()
  })
  window.addEventListener('focus', viewActivePane)
  syncAllWorkspaceStates()
  return () => {
    offAttention()
    offBlocks()
    offLayout()
    offWorkspaces()
    offUi()
    window.removeEventListener('focus', viewActivePane)
  }
}
