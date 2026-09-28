import type { SnapshotNode, SnapshotSession, WorkspaceSnapshot } from '@shared/types'
import { adoptIds, findPane, firstPaneId, withoutKind } from './tree'
import type { LayoutNode } from './types'

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

function fromLayoutNode(node: LayoutNode): SnapshotNode {
  if (node.type === 'pane') {
    const { kind, ...rest } = node
    return { ...rest, kind: kind === 'diff' ? 'terminal' : kind }
  }
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
  return { ...node, children: node.children.map(toLayoutNode), sizes: [...node.sizes] }
}

export function buildSnapshot(input: {
  sessions: RestorableSession[]
  activeSessionId: string
  layouts: Record<string, { root: LayoutNode; activePaneId: string }>
  savedAt: string
}): WorkspaceSnapshot | null {
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
  if (sessions.length === 0) return null
  return {
    v: 1,
    savedAt: input.savedAt,
    activeSessionId: input.activeSessionId,
    sessions,
  }
}

export function restoreWorkspace(snapshot: WorkspaceSnapshot): {
  sessions: RestorableSession[]
  activeSessionId: string
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
