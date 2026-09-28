import { Allotment } from 'allotment'
import { Terminal } from 'lucide-react'
import { useDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import type { LayoutNode } from '../layout/types'
import { useLayoutStore } from '../stores/layoutStore'
import { Pane } from './Pane'

export function PaneTree({ sessionId }: { sessionId: string }): JSX.Element {
  const layout = useLayoutStore((s) => s.bySession[sessionId])
  if (!layout) return <EmptyWorkspace sessionId={sessionId} />
  if (layout.zoomedPaneId) {
    const zoomed = findPane(layout.root, layout.zoomedPaneId)
    if (zoomed) {
      return <Pane tabs={[zoomed]} shownId={zoomed.id} active={zoomed.id === layout.activePaneId} />
    }
  }
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
    return <Pane tabs={[node]} shownId={node.id} active={node.id === activePaneId} />
  }
  if (node.type === 'tabs') {
    return (
      <Pane tabs={node.children} shownId={node.activeId} active={node.activeId === activePaneId} />
    )
  }

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

function EmptyWorkspace({ sessionId }: { sessionId: string }): JSX.Element {
  const d = useDict()
  const ensure = useLayoutStore((s) => s.ensure)
  return (
    <div className="workspace-empty">
      <button type="button" className="rail-add" onClick={() => ensure(sessionId)}>
        <Terminal size={14} />
        <span>{d.pane.newTerminal}</span>
      </button>
    </div>
  )
}
