import { Allotment, type AllotmentHandle } from 'allotment'
import { type DragEvent, useLayoutEffect, useRef } from 'react'
import { useSessionStaysStatus } from '@/components/agents/SessionStaysStatus'
import { NoticeSlot } from '@/components/common/NoticeSlot'
import { fmt, useDict } from '@/lib/app/useDict'
import { useFlipped } from '@/lib/app/useFlipped'
import { isStrip, STRIP_SIZE, stripSizes } from '@/lib/layout/collapse'
import type { Direction, LayoutNode, PaneNode, SplitNode } from '@/lib/layout/types'
import { cellDropTarget, dropZoneAt } from '@/lib/panes/dropZone'
import { dropPaneOn, isPaneDrag, PANE_DND } from '@/lib/panes/paneDrag'
import { cn } from '@/lib/utils'
import { stateLabel } from '@/lib/workspaces/workspaceState'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneDnd } from '@/stores/workspaces/paneDndStore'
import { FileDropCover } from './FileDropCover'
import { useKeptLinkStatus } from './KeptLinkStatus'
import { PaneTabMenu } from './PaneTabMenu'
import { usePhoneSizeStatus } from './PhoneSizeStatus'
import { focusPane } from './SplitTab'
import { TabBody } from './TabBody'
import { TabFace, usePaneMark } from './TabFace'
import { usePanePrompt } from './usePanePrompt'

interface CellContext {
  workspaceId: string
  shown: boolean
  focusedId: string
  frameActive: boolean
  stackTabIds: readonly string[]
}

function StripFace({
  pane,
  workspaceId,
  entering,
}: {
  pane: PaneNode
  workspaceId: string
  entering: boolean
}): JSX.Element {
  const d = useDict()
  const title = pane.title
  const state = useAttentionStore((s) => s.byPane[pane.id]?.state ?? 'none')
  const face = (
    <button
      type="button"
      className={cn('pane-strip-main text-ui-sm', entering && 'motion-fade')}
      aria-label={fmt(d.pane.expandSplitPane, { title })}
      onClick={() => focusPane(pane.id)}
    >
      <TabFace pane={pane} segment />
      {state === 'none' ? null : (
        <span className="pane-strip-state text-ui-xs">{stateLabel(d, state)}</span>
      )}
    </button>
  )
  return <PaneTabMenu pane={pane} workspaceId={workspaceId} trigger={face} />
}

function SplitCell({
  pane,
  ctx,
  across,
}: {
  pane: PaneNode
  ctx: CellContext
  across: Direction
}): JSX.Element {
  const cellRef = useRef<HTMLDivElement>(null)
  const dragging = usePaneDnd((s) => s.dragging)
  const over = usePaneDnd((s) => (s.overId === pane.id ? s.zone : null))
  const prompt = usePanePrompt(pane)
  const phoneStatus = usePhoneSizeStatus(pane.id)
  const keptLinkStatus = useKeptLinkStatus(pane.id)
  const staysStatus = useSessionStaysStatus(pane.id)
  const dimInactive = useSettingsStore((s) => s.panes.dimInactive)
  const mark = usePaneMark(pane)
  const focused = pane.id === ctx.focusedId
  const collapsed = pane.collapsed === true
  const folding = useFlipped({ strip: collapsed }).has('strip')

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
      className={
        collapsed
          ? 'pane-strip'
          : cn(
              'pane-cell',
              focused && 'focused',
              ctx.frameActive && !focused && dimInactive && 'dimmed',
            )
      }
      data-cell-id={collapsed ? undefined : pane.id}
      data-strip-id={collapsed ? pane.id : undefined}
      data-across={collapsed ? across : undefined}
      data-attention={collapsed ? (mark ?? undefined) : undefined}
    >
      {collapsed ? (
        <StripFace pane={pane} workspaceId={ctx.workspaceId} entering={folding} />
      ) : null}
      <TabBody pane={pane} shown={!collapsed} />
      <NoticeSlot>
        {collapsed || !ctx.shown ? null : (keptLinkStatus ?? staysStatus ?? phoneStatus)}
      </NoticeSlot>
      <NoticeSlot>{collapsed || !ctx.shown ? null : prompt}</NoticeSlot>
      {collapsed ? null : <FileDropCover kind={pane.kind} workspaceId={ctx.workspaceId} />}
      {dragging && !collapsed ? (
        <div
          className="pane-cell-drop-layer"
          onDragOver={onDragOver}
          onDragLeave={() => usePaneDnd.getState().leave(pane.id)}
          onDrop={onDrop}
        />
      ) : null}
      {over && !collapsed ? <span className={`pane-drop pane-drop-${over}`} /> : null}
    </div>
  )
}

function SplitTabSplit({
  split,
  ctx,
  band,
}: {
  split: SplitNode
  ctx: CellContext
  band: Direction | null
}): JSX.Element {
  const resize = useLayoutStore((s) => s.resize)
  const allotment = useRef<AllotmentHandle>(null)
  const reported = useRef<number[]>([])
  const sizes = useRef(split.sizes)
  sizes.current = split.sizes
  const laidOut = useRef<string | null>(null)
  const strips = split.children.map((child) => band === null && isStrip(child))
  const stripKey = strips.map(Number).join('')
  const measured = reported.current.reduce((sum, n) => sum + n, 0)

  useLayoutEffect(() => {
    const total = reported.current.reduce((sum, n) => sum + n, 0)
    const marks = [...stripKey].map((c) => c === '1')
    const before = laidOut.current ?? stripKey
    const opened = marks.map((strip, i) => !strip && before[i] === '1')
    laidOut.current = stripKey
    if (total > 0) allotment.current?.resize(stripSizes(sizes.current, marks, total, opened))
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
          minSize={band ? STRIP_SIZE : strips[i] ? STRIP_SIZE : 120}
          maxSize={strips[i] ? STRIP_SIZE : Number.POSITIVE_INFINITY}
        >
          <SplitTabNode
            node={child}
            ctx={ctx}
            across={band ?? split.direction}
            band={band ?? (strips[i] ? split.direction : null)}
          />
        </Allotment.Pane>
      ))}
    </Allotment>
  )
}

function SplitTabNode({
  node,
  ctx,
  across,
  band,
}: {
  node: LayoutNode
  ctx: CellContext
  across: Direction
  band: Direction | null
}): JSX.Element | null {
  if (node.type === 'pane') return <SplitCell pane={node} ctx={ctx} across={across} />
  if (node.type === 'tabs') return null
  return <SplitTabSplit split={node} ctx={ctx} band={band} />
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
      <SplitTabNode node={tab} ctx={ctx} across={tab.direction} band={null} />
    </div>
  )
}
