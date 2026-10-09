import {
  type FocusDirection,
  adjacentTab,
  findPane,
  isPaneShown,
  paneIds,
  paneInDirection,
} from '@/layout/tree'
import { globalWorkspaceOrder, latestRemoteUnread } from '@/lib/workspaces/windowWorkspaces'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { coversWorkspaces, useUIStore } from '@/stores/app/uiStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { focusSurface } from '@/stores/workspaces/surfaceSlotsStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { AttentionState } from '@shared/types'
import { useSyncExternalStore } from 'react'
import {
  type AttentionEvent,
  type PaneAttention,
  aggregateWorkspaceState,
  latestUnread,
  paneLiveState,
} from './attention'
import { isPanePointedAt, pointAtPane } from './pointerView'

export function shouldNotifyCommandEnd(
  durationMs: number,
  windowFocused: boolean,
  thresholdSeconds: number,
): boolean {
  return !windowFocused && durationMs >= thresholdSeconds * 1000
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
  if (coversWorkspaces(useUIStore.getState())) return false
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  if (!layout) return false
  if (layout.zoomedPaneId) return layout.zoomedPaneId === paneId
  return isPaneShown(layout.root, paneId)
}

function subscribeVisibility(onChange: () => void): () => void {
  const offs = [
    useWorkspacesStore.subscribe(onChange),
    useUIStore.subscribe(onChange),
    useLayoutStore.subscribe(onChange),
  ]
  return () => {
    for (const off of offs) off()
  }
}

export function usePaneVisible(paneId: string): boolean {
  return useSyncExternalStore(subscribeVisibility, () => isPaneVisible(paneId))
}

export function isPaneViewed(paneId: string): boolean {
  if (!document.hasFocus() || !isPaneVisible(paneId)) return false
  if (isPanePointedAt(paneId, Date.now())) return true
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  return (
    !!workspaceId && useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId === paneId
  )
}

export function viewPointedPane(paneId: string): void {
  pointAtPane(paneId, Date.now())
  if (!useAttentionStore.getState().byPane[paneId]?.unread) return
  if (!document.hasFocus() || !isPaneVisible(paneId)) return
  useAttentionStore.getState().dispatch(paneId, { type: 'view', at: Date.now() })
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
  if (!document.hasFocus() || coversWorkspaces(useUIStore.getState())) return
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (!workspaceId) return
  const paneId = useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
  if (paneId) useAttentionStore.getState().dispatch(paneId, { type: 'view', at: Date.now() })
}

export function markWorkspaceRead(workspaceId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  if (!layout) return
  const attention = useAttentionStore.getState()
  const at = Date.now()
  for (const paneId of paneIds(layout.root)) {
    if (attention.byPane[paneId]?.unread) attention.dispatch(paneId, { type: 'view', at })
  }
}

export function goToWorkspace(index: number): boolean {
  const { windowId, list } = useWindowsStore.getState()
  const local = useWorkspacesStore.getState().workspaces.map((w) => w.id)
  const target = globalWorkspaceOrder(list, windowId, local)[index]
  if (!target) return false
  if (target.windowId !== windowId && target.windowId !== null) {
    window.ostia.windows.focusWorkspace(target.id, false)
    return true
  }
  useUIStore.getState().showWorkspaces()
  useWorkspacesStore.getState().setActive(target.id)
  return true
}

export function stepWorkspace(step: 1 | -1): boolean {
  const { windowId, list } = useWindowsStore.getState()
  const workspaces = useWorkspacesStore.getState()
  const order = globalWorkspaceOrder(
    list,
    windowId,
    workspaces.workspaces.map((w) => w.id),
  )
  if (order.length === 0) return false
  const current = order.findIndex((w) => w.id === workspaces.activeWorkspaceId)
  const next = current === -1 ? 0 : (current + step + order.length) % order.length
  return next === current ? false : goToWorkspace(next)
}

export function focusPaneInDirection(
  workspaceId: string,
  paneId: string,
  direction: FocusDirection,
): boolean {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  if (!layout || layout.zoomedPaneId) return false
  const target = paneInDirection(layout.root, paneId, direction)
  if (!target) return false
  useLayoutStore.getState().focusPane(workspaceId, target)
  requestAnimationFrame(() => focusSurface(target))
  return true
}

export function focusAdjacentTab(workspaceId: string, paneId: string, step: 1 | -1): boolean {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  if (!layout || layout.zoomedPaneId) return false
  const target = adjacentTab(layout.root, paneId, step)
  if (!target) return false
  useLayoutStore.getState().focusPane(workspaceId, target)
  requestAnimationFrame(() => focusSurface(target))
  return true
}

export function revealPane(paneId: string): boolean {
  const workspaceId = workspaceOfPane(paneId)
  if (!workspaceId) return false
  useUIStore.getState().showWorkspaces()
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
  const { byPane } = useAttentionStore.getState()
  const target = latestUnread(byPane, allPaneIds())
  const { windowId, list } = useWindowsStore.getState()
  const remote = latestRemoteUnread(list, windowId, target ? byPane[target].at : 0)
  if (remote) {
    window.ostia.windows.focusWorkspace(remote.id, true)
    return null
  }
  if (!target) return null
  return revealPane(target) ? target : null
}

export function jumpToLatestUnreadIn(workspaceId: string): boolean {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  const target = layout
    ? latestUnread(useAttentionStore.getState().byPane, paneIds(layout.root))
    : null
  return target !== null && revealPane(target)
}

export interface PaneAttentionChange {
  paneId: string
  state: AttentionState
  message?: string
}

export function paneAttentionChanges(
  next: Readonly<Record<string, PaneAttention>>,
  prev: Readonly<Record<string, PaneAttention>>,
): PaneAttentionChange[] {
  const changes: PaneAttentionChange[] = []
  for (const [paneId, attention] of Object.entries(next)) {
    const before = prev[paneId]
    if (before?.state === attention.state && before?.message === attention.message) continue
    if (!before && attention.state === 'none') continue
    changes.push({
      paneId,
      state: attention.state,
      ...(attention.message ? { message: attention.message } : {}),
    })
  }
  return changes
}

export function startAttentionSync(): () => void {
  const offAttention = useAttentionStore.subscribe((s, prev) => {
    if (s.byPane === prev.byPane) return
    for (const change of paneAttentionChanges(s.byPane, prev.byPane)) {
      window.ostia?.lifecycle?.emit?.({ type: 'pane-attention', ...change })
    }
    syncAllWorkspaceStates()
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
    if (coversWorkspaces(s) !== coversWorkspaces(prev)) viewActivePane()
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
