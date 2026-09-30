import { GlobeIcon, TerminalWindowIcon } from '@phosphor-icons/react'
import { Allotment } from 'allotment'
import { useDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import type { LayoutNode } from '../layout/types'
import { useLayoutStore } from '../stores/layoutStore'
import { Pane } from './Pane'
import { Button } from './ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty'

export function PaneTree({ workspaceId }: { workspaceId: string }): JSX.Element {
  const layout = useLayoutStore((s) => s.byWorkspace[workspaceId])
  if (!layout) return <EmptyWorkspace workspaceId={workspaceId} />
  if (layout.zoomedPaneId) {
    const zoomed = findPane(layout.root, layout.zoomedPaneId)
    if (zoomed) {
      return <Pane tabs={[zoomed]} shownId={zoomed.id} active={zoomed.id === layout.activePaneId} />
    }
  }
  return (
    <NodeView node={layout.root} workspaceId={workspaceId} activePaneId={layout.activePaneId} />
  )
}

function NodeView({
  node,
  workspaceId,
  activePaneId,
}: {
  node: LayoutNode
  workspaceId: string
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
      onChange={(sizes) => resize(workspaceId, node.id, sizes)}
    >
      {node.children.map((child) => (
        <Allotment.Pane key={child.id} minSize={160}>
          <NodeView node={child} workspaceId={workspaceId} activePaneId={activePaneId} />
        </Allotment.Pane>
      ))}
    </Allotment>
  )
}

function EmptyWorkspace({ workspaceId }: { workspaceId: string }): JSX.Element {
  const d = useDict()
  const ensure = useLayoutStore((s) => s.ensure)
  const openBrowser = useLayoutStore((s) => s.openBrowser)
  return (
    <Empty className="workspace-empty h-full">
      <EmptyHeader>
        <EmptyTitle className="font-semibold text-fg text-ui-lg">
          <h2>{d.pane.emptyTitle}</h2>
        </EmptyTitle>
        <EmptyDescription className="text-ui-base">{d.pane.emptyBody}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button onClick={() => ensure(workspaceId)}>
          <TerminalWindowIcon data-icon="inline-start" />
          {d.pane.newTerminal}
        </Button>
        <Button variant="outline" onClick={() => openBrowser(workspaceId, 'about:blank')}>
          <GlobeIcon data-icon="inline-start" />
          {d.pane.newBrowser}
        </Button>
      </EmptyContent>
    </Empty>
  )
}
