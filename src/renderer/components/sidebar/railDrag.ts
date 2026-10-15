import type { DragSource, DropTarget } from '@/lib/sidebar/workspaceGroups'
import { canMoveTabTo, workspaceOfTab } from '@/lib/workspaces/tabWorkspaceMove'
import { usePaneDnd } from '@/stores/workspaces/paneDndStore'

export const WORKSPACE_DND = 'application/x-ostia-workspace'
export const GROUP_DND = 'application/x-ostia-workspace-group'

type RailTarget = DropTarget | { kind: 'merge'; id: string }

export interface RailDrag {
  source: DragSource
  target: RailTarget | null
  mergeable: ReadonlySet<string>
}

export function isRailDrag(e: React.DragEvent): boolean {
  const types = e.dataTransfer.types
  return types.includes(WORKSPACE_DND) || types.includes(GROUP_DND)
}

export function sameTarget(a: RailTarget | null, b: RailTarget): boolean {
  if (!a || a.kind !== b.kind) return false
  if (a.kind === 'end' || b.kind === 'end') return true
  if (a.kind === 'merge' || b.kind === 'merge') return a.id === b.id
  return a.id === b.id && a.place === b.place
}

export function dragFraction(e: React.DragEvent): number {
  const box = e.currentTarget.getBoundingClientRect()
  if (box.height > 0) return (e.clientY - box.top) / box.height
  return e.clientY < box.top ? 0 : 1
}

export function upperHalf(e: React.DragEvent): boolean {
  return dragFraction(e) < 0.5
}

export interface DragHandlers {
  start: (source: DragSource) => void
  over: (target: RailTarget) => void
  drop: () => void
  end: () => void
}

export interface TabDropHandlers {
  over: (workspaceId: string) => void
  leave: (workspaceId: string) => void
  drop: (workspaceId: string) => void
}

export function draggedTab(): { tabId: string; sourceId: string } | null {
  const tabId = usePaneDnd.getState().sourceId
  const sourceId = tabId ? workspaceOfTab(tabId) : null
  return tabId && sourceId ? { tabId, sourceId } : null
}

export function takesDraggedTab(workspaceId: string): boolean {
  const dragged = draggedTab()
  return dragged !== null && canMoveTabTo(dragged.sourceId, dragged.tabId, workspaceId)
}
