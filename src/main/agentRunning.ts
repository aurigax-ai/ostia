import type {
  AppSnapshot,
  SnapshotNode,
  SnapshotPaneNode,
  SnapshotWorkspace,
} from '../shared/types'

function snapshotWorkspaces(snapshot: AppSnapshot): SnapshotWorkspace[] {
  return [...snapshot.workspaces, ...(snapshot.windows ?? []).flatMap((w) => w.workspaces)]
}

function runningPaneIds(node: SnapshotNode | undefined, out: Set<string>): void {
  if (!node) return
  if (node.type === 'pane') {
    if (node.agentRunning) out.add(node.id)
    return
  }
  for (const child of node.children) runningPaneIds(child, out)
}

function markPane(pane: SnapshotPaneNode, panes: ReadonlySet<string>): SnapshotPaneNode {
  return pane.resume && panes.has(pane.id) ? { ...pane, agentRunning: true } : pane
}

function markNode(node: SnapshotNode, panes: ReadonlySet<string>): SnapshotNode {
  if (node.type === 'pane') return markPane(node, panes)
  if (node.type === 'tabs')
    return { ...node, children: node.children.map((c) => markPane(c, panes)) }
  return { ...node, children: node.children.map((c) => markNode(c, panes)) }
}

function markWorkspace(
  workspace: SnapshotWorkspace,
  panes: ReadonlySet<string>,
): SnapshotWorkspace {
  return workspace.root ? { ...workspace, root: markNode(workspace.root, panes) } : workspace
}

export class AgentRunningPanes {
  private readonly panes = new Set<string>()

  constructor(private readonly onChange: () => void) {}

  seed(snapshot: AppSnapshot | null): void {
    if (!snapshot) return
    for (const workspace of snapshotWorkspaces(snapshot)) runningPaneIds(workspace.root, this.panes)
  }

  report(paneId: string, running: boolean, attached: boolean): void {
    if (!attached || this.panes.has(paneId) === running) return
    if (running) this.panes.add(paneId)
    else this.panes.delete(paneId)
    this.onChange()
  }

  shellEnded(paneId: string): void {
    if (this.panes.delete(paneId)) this.onChange()
  }

  mark(snapshot: AppSnapshot): AppSnapshot {
    if (this.panes.size === 0) return snapshot
    return {
      ...snapshot,
      workspaces: snapshot.workspaces.map((w) => markWorkspace(w, this.panes)),
      ...(snapshot.windows
        ? {
            windows: snapshot.windows.map((win) => ({
              ...win,
              workspaces: win.workspaces.map((w) => markWorkspace(w, this.panes)),
            })),
          }
        : {}),
    }
  }
}
