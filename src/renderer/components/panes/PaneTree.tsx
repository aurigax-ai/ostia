import { GlobeIcon, TerminalWindowIcon } from '@phosphor-icons/react'
import { Allotment } from 'allotment'
import { ChordButton } from '@/components/common/ChordButton'
import { EmptyState } from '@/components/common/EmptyState'
import { useDict } from '@/lib/app/useDict'
import { openBrowserAs } from '@/lib/browser/browserProfile'
import { panelFractions } from '@/lib/layout/panelSize'
import { findPane, slotKey } from '@/lib/layout/tree'
import type { LayoutNode } from '@/lib/layout/types'
import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import { rememberPanelFractions } from '@/lib/panes/panelSizes'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { Pane } from './Pane'

export function PaneTree({ workspaceId }: { workspaceId: string }): JSX.Element {
  const layout = useLayoutStore((s) => s.byWorkspace[workspaceId])
  if (!layout) return <EmptyWorkspace workspaceId={workspaceId} />
  if (layout.zoomedPaneId) {
    const zoomed = findPane(layout.root, layout.zoomedPaneId)
    if (zoomed) {
      return (
        <Pane
          tabs={[zoomed]}
          shownId={zoomed.id}
          activePaneId={layout.activePaneId}
          workspaceId={workspaceId}
        />
      )
    }
  }
  return (
    <NodeView
      node={layout.root}
      workspaceId={workspaceId}
      activePaneId={layout.activePaneId}
      equalized={layout.equalized ?? 0}
      split={false}
    />
  )
}

function NodeView({
  node,
  workspaceId,
  activePaneId,
  equalized,
  split,
}: {
  node: LayoutNode
  workspaceId: string
  activePaneId: string
  equalized: number
  split: boolean
}): JSX.Element {
  const resize = useLayoutStore((s) => s.resize)

  if (node.type === 'pane') {
    return (
      <Pane
        tabs={[node]}
        shownId={node.id}
        activePaneId={activePaneId}
        workspaceId={workspaceId}
        split={split}
      />
    )
  }
  if (node.type === 'tabs') {
    return (
      <Pane
        tabs={node.children}
        shownId={node.activeId}
        activePaneId={activePaneId}
        workspaceId={workspaceId}
        split={split}
      />
    )
  }

  const compositionKey = `${node.id}:${equalized}:${node.children.map(slotKey).join(',')}`

  return (
    <Allotment
      key={compositionKey}
      vertical={node.direction === 'vertical'}
      defaultSizes={node.sizes}
      onChange={(sizes) => resize(workspaceId, node.id, sizes)}
      onDragEnd={(sizes) => rememberPanelFractions(panelFractions(node, sizes))}
    >
      {node.children.map((child) => (
        <Allotment.Pane key={slotKey(child)} minSize={160}>
          <NodeView
            node={child}
            workspaceId={workspaceId}
            activePaneId={activePaneId}
            equalized={equalized}
            split
          />
        </Allotment.Pane>
      ))}
    </Allotment>
  )
}

function EmptyWorkspace({ workspaceId }: { workspaceId: string }): JSX.Element {
  const d = useDict()
  const ensure = useLayoutStore((s) => s.ensure)
  return (
    <EmptyState
      variant="surface"
      className="workspace-empty h-full"
      title={d.pane.emptyTitle}
      titleAs="h2"
      desc={d.pane.emptyBody}
      actionsClassName="flex-row justify-center"
      actions={
        <>
          <ChordButton
            command="tab.new"
            icon={<TerminalWindowIcon data-icon="inline-start" />}
            label={d.pane.newTerminal}
            onClick={() => {
              ensure(workspaceId)
              focusActivePaneWhenReady(workspaceId)
            }}
          />
          <ChordButton
            command="tab.newBrowser"
            variant="outline"
            icon={<GlobeIcon data-icon="inline-start" />}
            label={d.pane.newBrowser}
            onClick={() => openBrowserAs(workspaceId, 'about:blank', 'human')}
          />
        </>
      }
    />
  )
}
