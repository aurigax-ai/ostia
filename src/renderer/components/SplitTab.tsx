import { cn } from '@/lib/utils'
import { LockSimpleIcon, XIcon } from '@phosphor-icons/react'
import { Allotment } from 'allotment'
import { type DragEvent, type KeyboardEvent, useLayoutEffect, useRef } from 'react'
import { commands } from '../commands/registry'
import { fmt, useDict } from '../i18n/useDict'
import { allPanes } from '../layout/tree'
import type { LayoutNode, PaneNode, SplitNode } from '../layout/types'
import { cellDropTarget, dropZoneAt } from '../lib/dropZone'
import { PANE_DND, beginPaneDrag, dropPaneOn, endPaneDrag, isPaneDrag } from '../lib/paneDrag'
import { splitTabLayout } from '../lib/splitTabs'
import { useApprovalsStore } from '../stores/approvalsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { usePaneDnd } from '../stores/paneDndStore'
import { useQuestionsStore } from '../stores/questionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { focusSurface } from '../stores/surfaceSlotsStore'
import { ApprovalCard } from './ApprovalCard'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { PaneTabMenu } from './PaneTabMenu'
import { QuestionNotice } from './QuestionNotice'
import { TabBody } from './TabBody'
import { TabFace, usePaneMark, usePaneTitle } from './TabFace'

function focusPane(paneId: string): void {
  void commands.exec('pane.focus', { paneId })
  requestAnimationFrame(() => focusSurface(paneId))
}

function GlyphNode({ node, focusedId }: { node: LayoutNode; focusedId: string | null }) {
  if (node.type === 'pane') {
    return <span className={cn('split-tab-glyph-pane', node.id === focusedId && 'focused')} />
  }
  if (node.type === 'tabs') return null
  return (
    <span className="split-tab-glyph-split" data-direction={node.direction}>
      {node.children.map((child, i) => (
        <span
          key={child.id}
          className="split-tab-glyph-cell"
          style={{ flexGrow: node.sizes[i] ?? 1 }}
        >
          <GlyphNode node={child} focusedId={focusedId} />
        </span>
      ))}
    </span>
  )
}

export function SplitTabGlyph({
  tab,
  focusedId,
}: {
  tab: SplitNode
  focusedId: string | null
}): JSX.Element {
  return (
    <span className="split-tab-glyph" data-split-glyph={splitTabLayout(tab)} aria-hidden>
      <GlyphNode node={tab} focusedId={focusedId} />
    </span>
  )
}

function SplitTabSegment({
  pane,
  focused,
  showClose,
  workspaceId,
}: {
  pane: PaneNode
  focused: boolean
  showClose: boolean
  workspaceId: string | null
}): JSX.Element {
  const d = useDict()
  const title = usePaneTitle(pane)
  const mark = usePaneMark(pane)
  const segment = (
    <div
      className={cn('split-tab-segment', focused && 'focused', pane.locked && 'locked')}
      data-attention={mark ?? undefined}
      data-segment-id={pane.id}
      draggable
      onDragStart={(e) => {
        e.stopPropagation()
        e.dataTransfer.setData(PANE_DND, pane.id)
        e.dataTransfer.effectAllowed = 'move'
        beginPaneDrag(pane.id, e)
      }}
      onDragEnd={(e) => {
        e.stopPropagation()
        endPaneDrag(workspaceId, pane.id, e)
      }}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault()
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        e.stopPropagation()
        void commands.exec('pane.close', { paneId: pane.id })
      }}
    >
      <Hint label={title}>
        <button
          type="button"
          className="split-tab-segment-main"
          aria-current={focused ? 'true' : undefined}
          onClick={() => focusPane(pane.id)}
        >
          <TabFace pane={pane} />
        </button>
      </Hint>
      {pane.locked ? (
        <IconButton
          icon={LockSimpleIcon}
          label={d.pane.unlock}
          className="pane-tab-lock"
          onClick={() => commands.exec('pane.toggleLock', { paneId: pane.id })}
        />
      ) : showClose ? (
        <IconButton
          icon={XIcon}
          label={fmt(d.pane.closeSplitPane, { title })}
          className="pane-tab-close hover:text-attn-fg"
          onClick={() => commands.exec('pane.close', { paneId: pane.id })}
        />
      ) : null}
    </div>
  )
  return <PaneTabMenu pane={pane} workspaceId={workspaceId} trigger={segment} />
}

export function useSplitTabLabel(tab: SplitNode): string {
  const d = useDict()
  const layout = {
    sideBySide: d.pane.splitTabSideBySide,
    stacked: d.pane.splitTabStacked,
    grid: d.pane.splitTabGrid,
  }[splitTabLayout(tab)]
  const panes = allPanes(tab)
    .map((p) => p.title)
    .join(', ')
  return tab.name
    ? fmt(d.pane.splitTabNamed, { name: tab.name, layout, panes })
    : fmt(d.pane.splitTab, { layout, panes })
}

function moveSegmentFocus(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>('.split-tab-segment-main')]
  const at = buttons.indexOf(document.activeElement as HTMLElement)
  const next = at === -1 ? buttons[0] : buttons[at + (e.key === 'ArrowRight' ? 1 : -1)]
  if (!next) return
  e.preventDefault()
  next.focus()
}

export function SplitTabPill({
  tab,
  selected,
  focusedId,
  dropMark,
  showClose,
  workspaceId,
}: {
  tab: SplitNode
  selected: boolean
  focusedId: string
  dropMark: 'before' | 'after' | null
  showClose: boolean
  workspaceId: string | null
}): JSX.Element {
  const label = useSplitTabLabel(tab)
  return (
    <div
      className={cn(
        'pane-tab pane-split-tab',
        selected && 'selected',
        dropMark && `drop-${dropMark}`,
      )}
      role="tab"
      tabIndex={-1}
      aria-selected={selected}
      aria-label={label}
      data-tab-id={tab.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PANE_DND, tab.id)
        e.dataTransfer.effectAllowed = 'move'
        beginPaneDrag(tab.id, e)
      }}
      onDragEnd={(e) => endPaneDrag(workspaceId, tab.id, e)}
      onKeyDown={moveSegmentFocus}
    >
      <SplitTabGlyph tab={tab} focusedId={selected ? focusedId : null} />
      {tab.name ? <span className="split-tab-name">{tab.name}</span> : null}
      <div className="split-tab-pill">
        {allPanes(tab).map((pane) => (
          <SplitTabSegment
            key={pane.id}
            pane={pane}
            focused={selected && pane.id === focusedId}
            showClose={showClose}
            workspaceId={workspaceId}
          />
        ))}
      </div>
    </div>
  )
}

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

function SplitTabNode({ node, ctx }: { node: LayoutNode; ctx: CellContext }): JSX.Element | null {
  const resize = useLayoutStore((s) => s.resize)
  if (node.type === 'pane') return <SplitCell pane={node} ctx={ctx} />
  if (node.type === 'tabs') return null
  return (
    <Allotment
      key={`${node.id}:${node.children.map((c) => c.id).join(',')}`}
      vertical={node.direction === 'vertical'}
      defaultSizes={node.sizes}
      onChange={(sizes) => resize(ctx.workspaceId, node.id, sizes)}
    >
      {node.children.map((child) => (
        <Allotment.Pane key={child.id} minSize={120}>
          <SplitTabNode node={child} ctx={ctx} />
        </Allotment.Pane>
      ))}
    </Allotment>
  )
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
