import type {
  AppSnapshot,
  SnapshotGroup,
  SnapshotNode,
  SnapshotPaneNode,
  SnapshotWorkspace,
} from '@shared/types'
import { adoptIds, findPane, firstPaneId, withoutKind } from './tree'
import type { LayoutNode, PaneNode } from './types'

export interface RestorableWorkspace {
  id: string
  name: string
  customName?: string
  description?: string
  pinned?: boolean
  groupId?: string
  kind: 'agent' | 'terminal' | 'scratch'
  workDir: string
  projectDir?: string
}

export interface RestorableLayout {
  root: LayoutNode
  activePaneId: string
  zoomedPaneId: null
}

interface PaneMarks {
  live: ReadonlySet<string>
  hibernated: boolean
}

function fromPane(pane: PaneNode, marks: PaneMarks): SnapshotPaneNode {
  const { kind, hibernated, resumePending, ...rest } = pane
  const agentRunning = Boolean(rest.resume) && (marks.live.has(pane.id) || resumePending === true)
  const keepHibernated = marks.hibernated && hibernated === true && Boolean(rest.resume)
  return {
    ...rest,
    kind: kind === 'diff' ? 'terminal' : kind,
    ...(agentRunning ? { agentRunning: true } : {}),
    ...(keepHibernated ? { hibernated: true } : {}),
  }
}

function fromLayoutNode(node: LayoutNode, marks: PaneMarks): SnapshotNode {
  if (node.type === 'pane') return fromPane(node, marks)
  if (node.type === 'tabs')
    return { ...node, children: node.children.map((c) => fromPane(c, marks)) }
  return {
    ...node,
    children: node.children.map((c) => fromLayoutNode(c, marks)),
    sizes: [...node.sizes],
  }
}

function toPane(node: SnapshotPaneNode): PaneNode {
  const { agentRunning, ...rest } = node
  return agentRunning && rest.resume ? { ...rest, resumePending: true } : { ...rest }
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
  if (node.type === 'pane') return toPane(node)
  if (node.type === 'tabs') return { ...node, children: node.children.map(toPane) }
  return { ...node, children: node.children.map(toLayoutNode), sizes: [...node.sizes] }
}

function copyGroup(group: SnapshotGroup): SnapshotGroup {
  return {
    id: group.id,
    name: group.name,
    ...(group.color ? { color: group.color } : {}),
    ...(group.collapsed ? { collapsed: true } : {}),
  }
}

function snapshotWorkspace(
  workspace: RestorableWorkspace,
  layout: { root: LayoutNode; activePaneId: string } | undefined,
  marks: PaneMarks,
): SnapshotWorkspace {
  const root = layout ? persistableRoot(layout.root, workspace.workDir) : null
  return {
    id: workspace.id,
    name: workspace.name,
    ...(workspace.customName ? { customName: workspace.customName } : {}),
    ...(workspace.description ? { description: workspace.description } : {}),
    ...(workspace.pinned ? { pinned: true } : {}),
    ...(workspace.groupId ? { groupId: workspace.groupId } : {}),
    kind: workspace.kind,
    workDir: workspace.workDir,
    ...(workspace.projectDir ? { projectDir: workspace.projectDir } : {}),
    ...(layout && root
      ? {
          root: fromLayoutNode(root, marks),
          activePaneId: findPane(root, layout.activePaneId)
            ? layout.activePaneId
            : firstPaneId(root),
        }
      : {}),
  }
}

export function workspaceHandoff(
  workspace: RestorableWorkspace,
  layout: { root: LayoutNode; activePaneId: string } | undefined,
  liveAgentPanes: ReadonlySet<string>,
): SnapshotWorkspace {
  const { groupId: _group, ...rest } = workspace
  return snapshotWorkspace(rest, layout, { live: liveAgentPanes, hibernated: true })
}

export function buildSnapshot(input: {
  workspaces: RestorableWorkspace[]
  groups: SnapshotGroup[]
  activeWorkspaceId: string | null
  layouts: Record<string, { root: LayoutNode; activePaneId: string }>
  savedAt: string
  liveAgentPanes?: ReadonlySet<string>
}): AppSnapshot {
  const marks: PaneMarks = { live: input.liveAgentPanes ?? new Set<string>(), hibernated: false }
  const workspaces = input.workspaces.map((workspace) =>
    snapshotWorkspace(workspace, input.layouts[workspace.id], marks),
  )
  const activeWorkspaceId = workspaces.some((s) => s.id === input.activeWorkspaceId)
    ? input.activeWorkspaceId
    : (workspaces[0]?.id ?? null)
  return {
    v: 1,
    savedAt: input.savedAt,
    activeWorkspaceId,
    workspaces,
    groups: input.groups.filter((g) => workspaces.some((w) => w.groupId === g.id)).map(copyGroup),
  }
}

export function restoreSnapshot(snapshot: AppSnapshot): {
  workspaces: RestorableWorkspace[]
  groups: SnapshotGroup[]
  activeWorkspaceId: string | null
  layouts: Record<string, RestorableLayout>
} {
  const workspaces: RestorableWorkspace[] = []
  const layouts: Record<string, RestorableLayout> = {}
  for (const s of snapshot.workspaces) {
    workspaces.push({
      id: s.id,
      name: s.name,
      ...(s.customName ? { customName: s.customName } : {}),
      ...(s.description ? { description: s.description } : {}),
      ...(s.pinned ? { pinned: true } : {}),
      ...(s.groupId ? { groupId: s.groupId } : {}),
      kind: s.kind,
      workDir: s.workDir,
      ...(s.projectDir ? { projectDir: s.projectDir } : {}),
    })
    if (!s.root) continue
    const root = toLayoutNode(s.root)
    adoptIds(root)
    layouts[s.id] = { root, activePaneId: s.activePaneId ?? firstPaneId(root), zoomedPaneId: null }
  }
  return {
    workspaces,
    groups: snapshot.groups.map(copyGroup),
    activeWorkspaceId: snapshot.activeWorkspaceId,
    layouts,
  }
}
