import type { SnapshotNode, SnapshotSession, WorkspaceSnapshot } from '@shared/types'
import { adoptIds } from './tree'
import type { LayoutNode } from './types'

/**
 * Translation between the live layout stores and the durable {@link WorkspaceSnapshot}
 * (session restore — see `main/sessionSnapshot.ts` for the on-disk half).
 *
 * Deliberately store-independent: it takes and returns plain data rather than importing
 * `sessionsStore`/`layoutStore`, so the stores can import THIS without a cycle. The two
 * `*LayoutNode` converters below are also the drift guard between `layout/types.ts` and the
 * mirrored snapshot types in `shared/types.ts` — if either tree grows a surface kind or a
 * field the other lacks, one of them stops compiling.
 */

/** The persistable half of a session: everything except its live `state`. */
export interface RestorableSession {
  id: string
  name: string
  kind: 'agent' | 'terminal' | 'scratch'
  workDir: string
}

/** A restored per-session layout — structurally `layoutStore`'s `SessionLayout`. */
export interface RestorableLayout {
  root: LayoutNode
  activePaneId: string
  /** Always null: a zoom is a transient view of the workspace, not its shape. */
  zoomedPaneId: null
}

/** Live tree → snapshot tree (deep copy: the snapshot must not alias store state). */
function fromLayoutNode(node: LayoutNode): SnapshotNode {
  if (node.type === 'pane') return { ...node }
  return { ...node, children: node.children.map(fromLayoutNode), sizes: [...node.sizes] }
}

/** Snapshot tree → live tree (deep copy: the store must own what it mutates). */
function toLayoutNode(node: SnapshotNode): LayoutNode {
  if (node.type === 'pane') return { ...node }
  return { ...node, children: node.children.map(toLayoutNode), sizes: [...node.sizes] }
}

/**
 * Capture the workspace. Sessions with no layout yet are skipped (there's nothing to
 * restore them to), and a capture with no sessions left returns null rather than an empty
 * snapshot — writing "zero sessions" would be indistinguishable from a real workspace the
 * user had emptied, and the next launch would restore a blank window.
 */
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
    sessions.push({
      id: session.id,
      name: session.name,
      kind: session.kind,
      workDir: session.workDir,
      root: fromLayoutNode(layout.root),
      activePaneId: layout.activePaneId,
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

/**
 * Rebuild live store state from a snapshot. Assumes `snapshot` already passed main's
 * `parseSnapshot` (unique pane ids, bounded depth, focus references repaired) — that's the
 * single validation gate, and `session:load` is the only way one reaches the renderer.
 *
 * Side effect by design: `adoptIds` reserves every restored id against the tree's counter,
 * which starts at 0 in a fresh process. Skipping it lets a newly split pane be handed an id
 * a restored pane already holds, and main keys ptys by pane id — the two panes would end up
 * sharing one shell.
 */
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
