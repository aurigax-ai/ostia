import type { AppSnapshot, SnapshotNode, SnapshotPaneNode, SnapshotWorkspace } from '@shared/types'
import { adoptIds, findPane, firstPaneId, withoutKind } from './tree'
import type { LayoutNode, PaneNode } from './types'

export interface RestorableWorkspace {
  id: string
  name: string
  kind: 'agent' | 'terminal' | 'scratch'
  workDir: string
}

export interface RestorableLayout {
  root: LayoutNode
  activePaneId: string
  zoomedPaneId: null
}

function fromPane(pane: PaneNode): SnapshotPaneNode {
  const { kind, ...rest } = pane
  return { ...rest, kind: kind === 'diff' ? 'terminal' : kind }
}

function fromLayoutNode(node: LayoutNode): SnapshotNode {
  if (node.type === 'pane') return fromPane(node)
  if (node.type === 'tabs') return { ...node, children: node.children.map(fromPane) }
  return { ...node, children: node.children.map(fromLayoutNode), sizes: [...node.sizes] }
}

function persistableRoot(root: LayoutNode, workDir: string): LayoutNode {
  return (
    withoutKind(root, 'diff') ?? {
      type: 'pane',
      id: firstPaneId(root),
      title: 'zsh',
      kind: 'terminal',
      cwd: workDir,
    }
  )
}

function toLayoutNode(node: SnapshotNode): LayoutNode {
  if (node.type === 'pane') return { ...node }
  if (node.type === 'tabs') return { ...node, children: node.children.map((c) => ({ ...c })) }
  return { ...node, children: node.children.map(toLayoutNode), sizes: [...node.sizes] }
}

export function buildSnapshot(input: {
  workspaces: RestorableWorkspace[]
  activeWorkspaceId: string | null
  layouts: Record<string, { root: LayoutNode; activePaneId: string }>
  savedAt: string
}): AppSnapshot {
  const workspaces: SnapshotWorkspace[] = []
  for (const workspace of input.workspaces) {
    const layout = input.layouts[workspace.id]
    if (!layout) continue
    const root = persistableRoot(layout.root, workspace.workDir)
    workspaces.push({
      id: workspace.id,
      name: workspace.name,
      kind: workspace.kind,
      workDir: workspace.workDir,
      root: fromLayoutNode(root),
      activePaneId: findPane(root, layout.activePaneId) ? layout.activePaneId : firstPaneId(root),
    })
  }
  const activeWorkspaceId = workspaces.some((s) => s.id === input.activeWorkspaceId)
    ? input.activeWorkspaceId
    : (workspaces[0]?.id ?? null)
  return {
    v: 1,
    savedAt: input.savedAt,
    activeWorkspaceId,
    workspaces,
  }
}

export function restoreSnapshot(snapshot: AppSnapshot): {
  workspaces: RestorableWorkspace[]
  activeWorkspaceId: string | null
  layouts: Record<string, RestorableLayout>
} {
  const workspaces: RestorableWorkspace[] = []
  const layouts: Record<string, RestorableLayout> = {}
  for (const s of snapshot.workspaces) {
    const root = toLayoutNode(s.root)
    adoptIds(root)
    workspaces.push({ id: s.id, name: s.name, kind: s.kind, workDir: s.workDir })
    layouts[s.id] = { root, activePaneId: s.activePaneId, zoomedPaneId: null }
  }
  return { workspaces, activeWorkspaceId: snapshot.activeWorkspaceId, layouts }
}
