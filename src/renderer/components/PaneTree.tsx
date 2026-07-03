import { Allotment } from 'allotment'
import { Terminal } from 'lucide-react'
import { useDict } from '../i18n/useDict'
import type { LayoutNode } from '../layout/types'
import { useLayoutStore } from '../stores/layoutStore'
import { Pane } from './Pane'

/**
 * Render a session's split-tree. Splits use allotment for resizing; each leaf is a
 * single-surface pane. The pane whose id is `activePaneId` is focused (accent ring).
 */
export function PaneTree({ sessionId }: { sessionId: string }): JSX.Element {
  const layout = useLayoutStore((s) => s.bySession[sessionId])
  if (!layout) return <EmptyWorkspace sessionId={sessionId} />
  return <NodeView node={layout.root} sessionId={sessionId} activePaneId={layout.activePaneId} />
}

function NodeView({
  node,
  sessionId,
  activePaneId,
}: {
  node: LayoutNode
  sessionId: string
  activePaneId: string
}): JSX.Element {
  const resize = useLayoutStore((s) => s.resize)

  if (node.type === 'pane') {
    return <Pane pane={node} active={node.id === activePaneId} />
  }

  // Allotment caches split sizes internally; when the *set* of children changes
  // (split / drag-relocate) it must rebuild, or panes mis-size (collapse to a sliver).
  // Keying by the children composition forces a clean splitview on structural change,
  // while pure resizes (same children) keep the same instance — no remount.
  const compositionKey = `${node.id}:${node.children.map((c) => c.id).join(',')}`

  return (
    <Allotment
      key={compositionKey}
      vertical={node.direction === 'vertical'}
      onChange={(sizes) => resize(sessionId, node.id, sizes)}
    >
      {node.children.map((child) => (
        <Allotment.Pane key={child.id} minSize={160}>
          <NodeView node={child} sessionId={sessionId} activePaneId={activePaneId} />
        </Allotment.Pane>
      ))}
    </Allotment>
  )
}

/** Shown when a session has no layout yet — opens its first terminal. */
function EmptyWorkspace({ sessionId }: { sessionId: string }): JSX.Element {
  const d = useDict()
  const ensure = useLayoutStore((s) => s.ensure)
  return (
    <div className="workspace-empty">
      <button type="button" className="rail-add" onClick={() => ensure(sessionId)}>
        <Terminal size={15} />
        <span>{d.pane.newTerminal}</span>
      </button>
    </div>
  )
}
