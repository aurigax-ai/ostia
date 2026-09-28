import type {
  SnapshotNode,
  SnapshotPaneNode,
  SnapshotSession,
  WorkspaceSnapshot,
} from '@shared/types'
import { adoptIds, findPane, firstPaneId, withoutKind } from './tree'
import type { LayoutNode, PaneNode } from './types'

export interface RestorableSession {
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
  sessions: RestorableSession[]
  activeSessionId: string | null
  layouts: Record<string, { root: LayoutNode; activePaneId: string }>
  savedAt: string
}): WorkspaceSnapshot {
  const sessions: SnapshotSession[] = []
  for (const session of input.sessions) {
    const layout = input.layouts[session.id]
    if (!layout) continue
    const root = persistableRoot(layout.root, session.workDir)
    sessions.push({
      id: session.id,
      name: session.name,
      kind: session.kind,
      workDir: session.workDir,
      root: fromLayoutNode(root),
      activePaneId: findPane(root, layout.activePaneId) ? layout.activePaneId : firstPaneId(root),
    })
  }
  const activeSessionId = sessions.some((s) => s.id === input.activeSessionId)
    ? input.activeSessionId
    : (sessions[0]?.id ?? null)
  return {
    v: 1,
    savedAt: input.savedAt,
    activeSessionId,
    sessions,
  }
}

export function restoreWorkspace(snapshot: WorkspaceSnapshot): {
  sessions: RestorableSession[]
  activeSessionId: string | null
  layouts: Record<string, RestorableLayout>
} {
  const sessions: RestorableSession[] = []
  const layouts: Record<string, RestorableLayout> = {}
  for (const s of snapshot.sessions) {
    const root = toLayoutNode(s.root)
    adoptIds(root)
    sessions.push({ id: s.id, name: s.name, kind: s.kind, workDir: s.workDir })
    layouts[s.id] = { root, activePaneId: s.activePaneId, zoomedPaneId: null }
  }
  return { sessions, activeSessionId: snapshot.activeSessionId, layouts }
}
