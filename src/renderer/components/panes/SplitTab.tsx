import { commands } from '@/commands/registry'
import { IconButton } from '@/components/common/IconButton'
import { RenameInput } from '@/components/common/RenameInput'
import { fmt, useDict } from '@/lib/app/useDict'
import { canCollapse, stripAxis } from '@/lib/layout/collapse'
import { allPanes } from '@/lib/layout/tree'
import type { LayoutNode, PaneNode, SplitNode } from '@/lib/layout/types'
import { PANE_DND, beginPaneDrag, endPaneDrag } from '@/lib/panes/paneDrag'
import { splitTabLayout } from '@/lib/panes/splitTabs'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'
import { focusSurface } from '@/stores/workspaces/surfaceSlotsStore'
import {
  ArrowsInLineHorizontalIcon,
  ArrowsInLineVerticalIcon,
  ArrowsOutLineHorizontalIcon,
  ArrowsOutLineVerticalIcon,
  LockSimpleIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { PaneRenameField } from './PaneRenameField'
import { PaneTabMenu } from './PaneTabMenu'
import { TabFace, usePaneMark, usePaneTitle } from './TabFace'
import { TabHint } from './TabHint'

export function focusPane(paneId: string): void {
  void commands.exec('pane.focus', { paneId })
  requestAnimationFrame(() => {
    if (usePaneRenameStore.getState().paneId !== paneId) focusSurface(paneId)
  })
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
  onDoubleClick,
}: {
  tab: SplitNode
  focusedId: string | null
  onDoubleClick?: () => void
}): JSX.Element {
  return (
    <span
      className="split-tab-glyph"
      data-split-glyph={splitTabLayout(tab)}
      aria-hidden
      onDoubleClick={onDoubleClick}
    >
      <GlyphNode node={tab} focusedId={focusedId} />
    </span>
  )
}

const COLLAPSE_ICONS = {
  horizontal: [ArrowsInLineHorizontalIcon, ArrowsOutLineHorizontalIcon],
  vertical: [ArrowsInLineVerticalIcon, ArrowsOutLineVerticalIcon],
} as const

function CollapseButton({ pane, tab }: { pane: PaneNode; tab: SplitNode }): JSX.Element | null {
  const d = useDict()
  const title = usePaneTitle(pane)
  const axis = stripAxis(tab, pane.id)
  if (!axis || (!pane.collapsed && !canCollapse(tab, pane.id))) return null
  const [collapseIcon, expandIcon] = COLLAPSE_ICONS[axis]
  return pane.collapsed ? (
    <IconButton
      icon={expandIcon}
      label={fmt(d.pane.expandSplitPane, { title })}
      className="pane-tab-collapse"
      onClick={() => focusPane(pane.id)}
    />
  ) : (
    <IconButton
      icon={collapseIcon}
      label={fmt(d.pane.collapseSplitPane, { title })}
      className="pane-tab-collapse"
      onClick={() => void commands.exec('pane.collapse', { paneId: pane.id })}
    />
  )
}

function SplitTabSegment({
  pane,
  tab,
  focused,
  showClose,
  workspaceId,
}: {
  pane: PaneNode
  tab: SplitNode
  focused: boolean
  showClose: boolean
  workspaceId: string | null
}): JSX.Element {
  const d = useDict()
  const title = usePaneTitle(pane)
  const mark = usePaneMark(pane)
  const renaming = usePaneRenameStore((s) => s.paneId === pane.id)
  const segment = (
    <div
      className={cn(
        'split-tab-segment',
        focused && 'focused',
        pane.locked && 'locked',
        pane.collapsed && 'collapsed',
      )}
      data-attention={mark ?? undefined}
      data-segment-id={pane.id}
      draggable={!renaming}
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
      {renaming ? (
        <PaneRenameField pane={pane} workspaceId={workspaceId} />
      ) : (
        <TabHint pane={pane}>
          <button
            type="button"
            className="split-tab-segment-main"
            aria-current={focused ? 'true' : undefined}
            onClick={() => focusPane(pane.id)}
            onDoubleClick={() => usePaneRenameStore.getState().begin(pane.id)}
          >
            <TabFace pane={pane} segment />
          </button>
        </TabHint>
      )}
      <CollapseButton pane={pane} tab={tab} />
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

function SplitTabRenameField({
  tab,
  workspaceId,
}: {
  tab: SplitNode
  workspaceId: string | null
}): JSX.Element {
  const d = useDict()
  return (
    <RenameInput
      value={tab.name ?? ''}
      label={d.pane.renameSplitTab}
      onDone={(name) => {
        usePaneRenameStore.getState().end()
        if (name === null || !workspaceId) return
        useLayoutStore.getState().renameSplitTab(workspaceId, tab.id, name)
      }}
    />
  )
}

function useSplitTabLabel(tab: SplitNode): string {
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
  if (e.target instanceof HTMLInputElement) return
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
  const panes = allPanes(tab)
  const renaming = usePaneRenameStore(
    (s) => s.splitTabId === tab.id || panes.some((p) => p.id === s.paneId),
  )
  const naming = usePaneRenameStore((s) => s.splitTabId === tab.id)
  const beginNaming = () => usePaneRenameStore.getState().beginSplitTab(tab.id)
  return (
    <div
      style={{ '--split-segments': panes.length } as CSSProperties}
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
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(PANE_DND, tab.id)
        e.dataTransfer.effectAllowed = 'move'
        beginPaneDrag(tab.id, e)
      }}
      onDragEnd={(e) => endPaneDrag(workspaceId, tab.id, e)}
      onKeyDown={moveSegmentFocus}
    >
      <SplitTabGlyph
        tab={tab}
        focusedId={selected ? focusedId : null}
        onDoubleClick={beginNaming}
      />
      {naming ? (
        <SplitTabRenameField tab={tab} workspaceId={workspaceId} />
      ) : tab.name ? (
        <span className="split-tab-name" onDoubleClick={beginNaming}>
          {tab.name}
        </span>
      ) : null}
      {panes.map((pane) => (
        <SplitTabSegment
          key={pane.id}
          pane={pane}
          tab={tab}
          focused={selected && pane.id === focusedId}
          showClose={showClose}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  )
}
