import { allPanes, findPane, findSplitTab, tabIdOf, takeTab } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { mergeChatWorkspace } from '../stores/chatStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { focusSurfaceWhenReady } from '../stores/surfaceSlotsStore'
import { useUIStore } from '../stores/uiStore'
import { type Workspace, type WorkspaceKind, useWorkspacesStore } from '../stores/workspacesStore'

export type TabMoveRefusal = 'same' | 'unknown' | 'manager' | 'scratch' | 'sandbox'

export interface TabMoveSide {
  id: string
  kind: WorkspaceKind
  sandboxed: boolean
}

export interface TabMoveTarget {
  id: string
  name: string
  refusal: TabMoveRefusal | null
}

export function tabMoveRefusal(
  source: TabMoveSide,
  target: TabMoveSide,
  panes: readonly Pick<PaneNode, 'kind'>[],
): TabMoveRefusal | null {
  if (source.id === target.id) return 'same'
  if (panes.length === 0) return 'unknown'
  if (target.kind === 'manager' || panes.some((p) => p.kind === 'manager')) return 'manager'
  if (source.kind === 'scratch' || target.kind === 'scratch') return 'scratch'
  if (source.sandboxed || target.sandboxed) return 'sandbox'
  return null
}

function sideOf(w: Workspace): TabMoveSide {
  return { id: w.id, kind: w.kind, sandboxed: useSandboxStore.getState().enabled[w.id] ?? false }
}

function tabPanes(workspaceId: string, tabId: string): PaneNode[] {
  const root = useLayoutStore.getState().byWorkspace[workspaceId]?.root
  if (!root) return []
  const pane = findPane(root, tabId)
  if (pane) return [pane]
  const split = findSplitTab(root, tabId)
  return split ? allPanes(split) : []
}

export function workspaceOfTab(tabId: string): string | null {
  const { byWorkspace } = useLayoutStore.getState()
  for (const [workspaceId, layout] of Object.entries(byWorkspace)) {
    if (layout && (findPane(layout.root, tabId) || findSplitTab(layout.root, tabId))) {
      return workspaceId
    }
  }
  return null
}

export function activeTabId(workspaceId: string): string | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  return layout ? tabIdOf(layout.root, layout.activePaneId) : null
}

export function tabMoveTargets(sourceId: string, tabId: string): TabMoveTarget[] {
  const { workspaces } = useWorkspacesStore.getState()
  const source = workspaces.find((w) => w.id === sourceId)
  if (!source) return []
  const panes = tabPanes(sourceId, tabId)
  return workspaces
    .filter((w) => w.id !== sourceId)
    .map((w) => ({
      id: w.id,
      name: w.customName ?? w.name,
      refusal: tabMoveRefusal(sideOf(source), sideOf(w), panes),
    }))
}

export function canMoveTabTo(sourceId: string, tabId: string, targetId: string): boolean {
  const { workspaces } = useWorkspacesStore.getState()
  const source = workspaces.find((w) => w.id === sourceId)
  const target = workspaces.find((w) => w.id === targetId)
  if (!source || !target) return false
  return tabMoveRefusal(sideOf(source), sideOf(target), tabPanes(sourceId, tabId)) === null
}

function finishWholeMove(sourceId: string, targetId: string, wasActive: boolean): void {
  mergeChatWorkspace(sourceId, targetId)
  const workspaces = useWorkspacesStore.getState()
  workspaces.release(sourceId)
  if (wasActive) workspaces.setActive(targetId)
  const ui = useUIStore.getState()
  if (ui.settingsWorkspaceId === sourceId) useUIStore.setState({ settingsWorkspaceId: targetId })
}

export async function moveTabToWorkspace(
  sourceId: string,
  tabId: string,
  targetId: string,
): Promise<boolean> {
  if (!canMoveTabTo(sourceId, tabId, targetId)) return false
  const root = useLayoutStore.getState().byWorkspace[sourceId]?.root
  const taken = root ? takeTab(root, tabId) : null
  if (!taken) return false
  const whole = taken.rest === null
  const paneIds = allPanes(taken.tab).map((p) => p.id)
  const result = await window.ostia.workspace.movePanes(sourceId, targetId, paneIds, whole)
  if (!result.ok) return false
  const wasActive = useWorkspacesStore.getState().activeWorkspaceId === sourceId
  const moved = useLayoutStore.getState().moveTabTo(sourceId, targetId, tabId)
  if (moved.length === 0) return false
  if (whole) finishWholeMove(sourceId, targetId, wasActive)
  const shown = wasActive ? useWorkspacesStore.getState().activeWorkspaceId : null
  const focus = shown ? useLayoutStore.getState().byWorkspace[shown]?.activePaneId : null
  if (focus) focusSurfaceWhenReady(focus)
  return true
}
