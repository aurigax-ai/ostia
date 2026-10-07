import type {
  AppSnapshot,
  SnapshotGroup,
  SnapshotNode,
  SnapshotPaneNode,
  SnapshotSplitNode,
  SnapshotWorkspace,
  WorkspaceOrigin,
} from '@shared/types'
import {
  TERMINAL_TITLE,
  adoptIds,
  findPane,
  firstPaneId,
  isRemoteFilePane,
  withoutPanes,
} from './tree'
import type { LayoutNode, PaneNode, SplitNode } from './types'

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
  anchored?: true
  origin?: WorkspaceOrigin
}

export interface RestorableLayout {
  root: LayoutNode
  activePaneId: string
  zoomedPaneId: null
}

function fromPane(pane: PaneNode, live: ReadonlySet<string>): SnapshotPaneNode {
  const { kind, hibernated, resumePending, ...rest } = pane
  const keepHibernated = hibernated === true && Boolean(rest.resume)
  const agentRunning =
    !keepHibernated && Boolean(rest.resume) && (live.has(pane.id) || resumePending === true)
  return {
    ...rest,
    kind: kind === 'diff' || kind === 'manager' ? 'terminal' : kind,
    ...(agentRunning ? { agentRunning: true } : {}),
    ...(keepHibernated ? { hibernated: true } : {}),
  }
}

function fromSplit(node: SplitNode, live: ReadonlySet<string>): SnapshotSplitNode {
  return {
    ...node,
    children: node.children.map((c) => fromLayoutNode(c, live)),
    sizes: [...node.sizes],
  }
}

function fromLayoutNode(node: LayoutNode, live: ReadonlySet<string>): SnapshotNode {
  if (node.type === 'pane') return fromPane(node, live)
  if (node.type === 'tabs') {
    return {
      ...node,
      children: node.children.map((c) =>
        c.type === 'pane' ? fromPane(c, live) : fromSplit(c, live),
      ),
    }
  }
  return fromSplit(node, live)
}

function toPane(node: SnapshotPaneNode): PaneNode {
  const { agentRunning, ...rest } = node
  return agentRunning && rest.resume ? { ...rest, resumePending: true } : { ...rest }
}

function persistableRoot(root: LayoutNode, workDir: string): LayoutNode {
  return (
    withoutPanes(root, (pane) => pane.kind === 'diff' || isRemoteFilePane(pane)) ?? {
      type: 'pane',
      id: firstPaneId(root),
      title: TERMINAL_TITLE,
      kind: 'terminal',
      cwd: workDir,
      defaultTitle: true,
    }
  )
}

function toSplit(node: SnapshotSplitNode): SplitNode {
  return { ...node, children: node.children.map(toLayoutNode), sizes: [...node.sizes] }
}

function toLayoutNode(node: SnapshotNode): LayoutNode {
  if (node.type === 'pane') return toPane(node)
  if (node.type === 'tabs') {
    return {
      ...node,
      children: node.children.map((c) => (c.type === 'pane' ? toPane(c) : toSplit(c))),
    }
  }
  return toSplit(node)
}

function copyGroup(group: SnapshotGroup): SnapshotGroup {
  return {
    id: group.id,
    name: group.name,
    ...(group.color ? { color: group.color } : {}),
    ...(group.collapsed ? { collapsed: true } : {}),
  }
}

function copyOrigin(origin: WorkspaceOrigin): WorkspaceOrigin {
  return {
    workspaceId: origin.workspaceId,
    index: origin.index,
    ...(origin.groupId ? { groupId: origin.groupId } : {}),
    ...(origin.beside ? { beside: { ...origin.beside } } : {}),
  }
}

function snapshotWorkspace(
  workspace: RestorableWorkspace,
  layout: { root: LayoutNode; activePaneId: string } | undefined,
  live: ReadonlySet<string>,
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
    ...(workspace.anchored ? { anchored: true as const } : {}),
    ...(workspace.origin ? { origin: copyOrigin(workspace.origin) } : {}),
    ...(layout && root
      ? {
          root: fromLayoutNode(root, live),
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
  return snapshotWorkspace(rest, layout, liveAgentPanes)
}

export function buildSnapshot(input: {
  workspaces: RestorableWorkspace[]
  groups: SnapshotGroup[]
  activeWorkspaceId: string | null
  layouts: Record<string, { root: LayoutNode; activePaneId: string }>
  savedAt: string
  liveAgentPanes?: ReadonlySet<string>
}): AppSnapshot {
  const live = input.liveAgentPanes ?? new Set<string>()
  const workspaces = input.workspaces.map((workspace) =>
    snapshotWorkspace(workspace, input.layouts[workspace.id], live),
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
      ...(s.anchored ? { anchored: true as const } : {}),
      ...(s.origin ? { origin: copyOrigin(s.origin) } : {}),
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
