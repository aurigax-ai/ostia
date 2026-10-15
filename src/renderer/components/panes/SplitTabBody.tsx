import { ApprovalCard } from '@/components/agents/ApprovalCard'
import { stateLabel } from '@/components/agents/PickSendPanel'
import { QuestionNotice } from '@/components/agents/QuestionNotice'
import { fmt, useDict } from '@/lib/app/useDict'
import { STRIP_SIZE, isStrip, stripSizes } from '@/lib/layout/collapse'
import { allPanes } from '@/lib/layout/tree'
import type { Direction, LayoutNode, PaneNode, SplitNode } from '@/lib/layout/types'
import { cellDropTarget, dropZoneAt } from '@/lib/panes/dropZone'
import { PANE_DND, dropPaneOn, isPaneDrag } from '@/lib/panes/paneDrag'
import { cn } from '@/lib/utils'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneDnd } from '@/stores/workspaces/paneDndStore'
import { Allotment, type AllotmentHandle } from 'allotment'
import { type DragEvent, useLayoutEffect, useRef } from 'react'
import { PaneTabMenu } from './PaneTabMenu'
import { ResumeConflictNotice, ResumeFailedNotice } from './ResumeFolderNotice'
import { focusPane } from './SplitTab'
import { TabBody } from './TabBody'
import { TabFace, usePaneMark, usePaneTitle } from './TabFace'

interface CellContext {
  workspaceId: string
  shown: boolean
  focusedId: string
  frameActive: boolean
  stackTabIds: readonly string[]
}

function SplitCell({ pane, ctx }: { pane: PaneNode; ctx: CellContext }): JSX.Element {
  const cellRef = useRef<HTMLDivElement>(null)
  const dragging = usePaneDnd((s) => s.dragging)
  const over = usePaneDnd((s) => (s.overId === pane.id ? s.zone : null))
  const approval = useApprovalsStore((s) =>
    ctx.shown ? s.pending.find((r) => r.paneId === pane.id) : undefined,
  )
  const question = useQuestionsStore((s) =>
    ctx.shown ? s.pending.find((q) => q.paneId === pane.id) : undefined,
  )
  const dimInactive = useSettingsStore((s) => s.panes.dimInactive)
  const focused = pane.id === ctx.focusedId

  const targetAt = (e: DragEvent<HTMLElement>, sourceId: string | null) => {
    const rect = cellRef.current?.getBoundingClientRect()
    const zone = rect ? dropZoneAt(rect, e.clientX, e.clientY) : 'center'
    return cellDropTarget(pane.id, ctx.stackTabIds, sourceId, zone)
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!isPaneDrag([...e.dataTransfer.types])) return
    e.preventDefault()
    const target = targetAt(e, usePaneDnd.getState().sourceId)
    if (!target) {
      e.dataTransfer.dropEffect = 'none'
      usePaneDnd.getState().leave(pane.id)
      return
    }
    e.dataTransfer.dropEffect = 'move'
    usePaneDnd.getState().setOver(pane.id, target.zone)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!isPaneDrag([...e.dataTransfer.types])) return
    e.preventDefault()
    const sourceId = e.dataTransfer.getData(PANE_DND)
    const target = sourceId ? targetAt(e, sourceId) : null
    if (!target) {
      usePaneDnd.getState().dropped()
      return
    }
    dropPaneOn(sourceId, target.targetId, target.zone)
  }

  return (
    <div
      ref={cellRef}
      className={cn(
        'pane-cell',
        focused && 'focused',
        ctx.frameActive && !focused && dimInactive && 'dimmed',
      )}
      data-cell-id={pane.id}
    >
      <TabBody pane={pane} shown />
      {approval ? (
        <ApprovalCard request={approval} paneTitle={pane.title} />
      ) : question ? (
        <QuestionNotice question={question} />
      ) : ctx.shown && pane.resumeFailed ? (
        <ResumeFailedNotice paneId={pane.id} failure={pane.resumeFailed} />
      ) : ctx.shown && pane.resume ? (
        <ResumeConflictNotice pane={pane} />
      ) : null}
      {dragging ? (
        <div
          className="pane-cell-drop-layer"
          onDragOver={onDragOver}
          onDragLeave={() => usePaneDnd.getState().leave(pane.id)}
          onDrop={onDrop}
        />
      ) : null}
      {over ? <span className={`pane-drop pane-drop-${over}`} /> : null}
    </div>
  )
}

function PaneStrip({
  pane,
  across,
  workspaceId,
}: {
  pane: PaneNode
  across: Direction
  workspaceId: string
}): JSX.Element {
  const d = useDict()
  const title = usePaneTitle(pane)
  const mark = usePaneMark(pane)
  const state = useAttentionStore((s) => s.byPane[pane.id]?.state ?? 'none')
  const strip = (
    <div
      className="pane-strip"
      data-across={across}
      data-attention={mark ?? undefined}
      data-strip-id={pane.id}
    >
      <button
        type="button"
        className="pane-strip-main text-ui-sm"
        aria-label={fmt(d.pane.expandSplitPane, { title })}
        onClick={() => focusPane(pane.id)}
      >
        <TabFace pane={pane} segment />
        {state === 'none' ? null : (
          <span className="pane-strip-state text-ui-xs">{stateLabel(d, state)}</span>
        )}
      </button>
      <TabBody pane={pane} shown={false} />
    </div>
  )
  return <PaneTabMenu pane={pane} workspaceId={workspaceId} trigger={strip} />
}

function Strips({
  node,
  across,
  workspaceId,
}: {
  node: LayoutNode
  across: Direction
  workspaceId: string
}): JSX.Element {
  if (node.type === 'pane') {
    return <PaneStrip pane={node} across={across} workspaceId={workspaceId} />
  }
  return (
    <div className="pane-strip-group" data-across={across}>
      {allPanes(node).map((pane) => (
        <PaneStrip key={pane.id} pane={pane} across={across} workspaceId={workspaceId} />
      ))}
    </div>
  )
}

function SplitTabSplit({ split, ctx }: { split: SplitNode; ctx: CellContext }): JSX.Element {
  const resize = useLayoutStore((s) => s.resize)
  const allotment = useRef<AllotmentHandle>(null)
  const reported = useRef<number[]>([])
  const sizes = useRef(split.sizes)
  sizes.current = split.sizes
  const strips = split.children.map(isStrip)
  const stripKey = strips.map(Number).join('')
  const measured = reported.current.reduce((sum, n) => sum + n, 0)

  useLayoutEffect(() => {
    const total = reported.current.reduce((sum, n) => sum + n, 0)
    const marks = [...stripKey].map((c) => c === '1')
    if (total > 0) allotment.current?.resize(stripSizes(sizes.current, marks, total))
  }, [stripKey])

  return (
    <Allotment
      ref={allotment}
      key={`${split.id}:${split.children.map((c) => c.id).join(',')}`}
      vertical={split.direction === 'vertical'}
      defaultSizes={stripSizes(split.sizes, strips, measured || undefined)}
      onChange={(next) => {
        reported.current = next
        resize(ctx.workspaceId, split.id, next)
      }}
    >
      {split.children.map((child, i) => (
        <Allotment.Pane
          key={child.id}
          minSize={strips[i] ? STRIP_SIZE : 120}
          maxSize={strips[i] ? STRIP_SIZE : Number.POSITIVE_INFINITY}
        >
          {strips[i] ? (
            <Strips node={child} across={split.direction} workspaceId={ctx.workspaceId} />
          ) : (
            <SplitTabNode node={child} ctx={ctx} />
          )}
        </Allotment.Pane>
      ))}
    </Allotment>
  )
}

function SplitTabNode({ node, ctx }: { node: LayoutNode; ctx: CellContext }): JSX.Element | null {
  if (node.type === 'pane') return <SplitCell pane={node} ctx={ctx} />
  if (node.type === 'tabs') return null
  return <SplitTabSplit split={node} ctx={ctx} />
}

export function SplitTabBody({ tab, ...ctx }: CellContext & { tab: SplitNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = !ctx.shown
  }, [ctx.shown])
  return (
    <div
      className="pane-slot pane-split-body"
      data-hidden={ctx.shown ? undefined : ''}
      data-split-tab-id={tab.id}
      ref={ref}
    >
      <SplitTabNode node={tab} ctx={ctx} />
    </div>
  )
}
