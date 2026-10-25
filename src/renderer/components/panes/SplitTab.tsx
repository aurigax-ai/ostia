import {
  ArrowsInLineHorizontalIcon,
  ArrowsInLineVerticalIcon,
  ArrowsOutLineHorizontalIcon,
  ArrowsOutLineVerticalIcon,
} from '@phosphor-icons/react'
import {
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  useEffect,
  useRef,
} from 'react'
import { commands } from '@/commands/registry'
import { IconButton } from '@/components/common/IconButton'
import { RenameInput } from '@/components/common/RenameInput'
import { fmt, useDict } from '@/lib/app/useDict'
import { isPaneVisible } from '@/lib/attention/workspaceActivity'
import { canCollapse, stripAxis } from '@/lib/layout/collapse'
import { allPanes } from '@/lib/layout/tree'
import type { LayoutNode, PaneNode, SplitNode } from '@/lib/layout/types'
import { beginPaneDrag, endPaneDrag, PANE_DND } from '@/lib/panes/paneDrag'
import { splitTabLayout } from '@/lib/panes/splitTabs'
import { cn } from '@/lib/utils'
import { requestCloseSplitTab } from '@/lib/workspaces/closeConfirm'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'
import { focusSurfaceWhenReady } from '@/stores/workspaces/surfaceSlotsStore'
import { PaneRenameField } from './PaneRenameField'
import { PaneTabMenu } from './PaneTabMenu'
import { TabEndAction } from './TabEndAction'
import { TabFace, usePaneMark } from './TabFace'
import { TabHint } from './TabHint'

export function focusPane(paneId: string): void {
  void commands.exec('pane.focus', { paneId })
  focusSurfaceWhenReady(
    paneId,
    () => isPaneVisible(paneId) && usePaneRenameStore.getState().paneId !== paneId,
  )
}

const DOUBLE_CLICK_MS = 250

export function closeSplitTabOnMiddleClick(
  tabId: string,
  workspaceId: string | null,
): Pick<HTMLAttributes<HTMLElement>, 'onMouseDown' | 'onAuxClick'> {
  return {
    onMouseDown: (e) => {
      if (e.button === 1) e.preventDefault()
    },
    onAuxClick: (e) => {
      if (e.button !== 1) return
      e.preventDefault()
      e.stopPropagation()
      if (workspaceId) void requestCloseSplitTab(workspaceId, tabId)
    },
  }
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

const COLLAPSE_ICONS = {
  horizontal: [ArrowsInLineHorizontalIcon, ArrowsOutLineHorizontalIcon],
  vertical: [ArrowsInLineVerticalIcon, ArrowsOutLineVerticalIcon],
} as const

function CollapseButton({ pane, tab }: { pane: PaneNode; tab: SplitNode }): JSX.Element | null {
  const d = useDict()
  const title = pane.title
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
  const title = pane.title
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
      <TabEndAction
        pane={pane}
        showClose={showClose}
        closeLabel={fmt(d.pane.closeSplitPane, { title })}
      />
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

function SplitTabHead({
  tab,
  focusedId,
  naming,
  workspaceId,
}: {
  tab: SplitNode
  focusedId: string | null
  naming: boolean
  workspaceId: string | null
}): JSX.Element {
  const d = useDict()
  const pendingFold = useRef<number>()
  useEffect(() => () => window.clearTimeout(pendingFold.current), [])
  if (naming) {
    return (
      <div className="split-tab-head">
        <SplitTabGlyph tab={tab} focusedId={focusedId} />
        <SplitTabRenameField tab={tab} workspaceId={workspaceId} />
      </div>
    )
  }
  const fold = () => void commands.exec('pane.foldSplitTab', { tabId: tab.id })
  return (
    <button
      type="button"
      className="split-tab-head"
      aria-expanded
      aria-label={
        tab.name ? fmt(d.pane.foldNamedSplitTab, { name: tab.name }) : d.pane.foldSplitTab
      }
      {...closeSplitTabOnMiddleClick(tab.id, workspaceId)}
      onClick={(e) => {
        if (e.detail > 1) return
        if (e.detail === 0) fold()
        else pendingFold.current = window.setTimeout(fold, DOUBLE_CLICK_MS)
      }}
      onDoubleClick={() => {
        window.clearTimeout(pendingFold.current)
        usePaneRenameStore.getState().beginSplitTab(tab.id)
      }}
    >
      <SplitTabGlyph tab={tab} focusedId={focusedId} />
      {tab.name ? <span className="split-tab-name">{tab.name}</span> : null}
    </button>
  )
}

function moveSegmentFocus(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  if (e.target instanceof HTMLInputElement) return
  const buttons = [
    ...e.currentTarget.querySelectorAll<HTMLElement>('.split-tab-head, .split-tab-segment-main'),
  ]
  const at = buttons.indexOf(document.activeElement as HTMLElement)
  const next = at === -1 ? buttons[0] : buttons[at + (e.key === 'ArrowRight' ? 1 : -1)]
  if (!next) return
  e.preventDefault()
  next.focus()
}

export function tabDragProps(
  tabId: string,
  workspaceId: string | null,
  draggable: boolean,
): Pick<HTMLAttributes<HTMLElement>, 'draggable' | 'onDragStart' | 'onDragEnd'> {
  return {
    draggable,
    onDragStart: (e) => {
      e.dataTransfer.setData(PANE_DND, tabId)
      e.dataTransfer.effectAllowed = 'move'
      beginPaneDrag(tabId, e)
    },
    onDragEnd: (e) => endPaneDrag(workspaceId, tabId, e),
  }
}

export function SplitTabPill({
  tab,
  selected,
  focusedId,
  dropMark,
  showClose,
  workspaceId,
  entering,
}: {
  tab: SplitNode
  selected: boolean
  focusedId: string
  dropMark: 'before' | 'after' | null
  showClose: boolean
  workspaceId: string | null
  entering: boolean
}): JSX.Element {
  const label = useSplitTabLabel(tab)
  const panes = allPanes(tab)
  const renaming = usePaneRenameStore(
    (s) => s.splitTabId === tab.id || panes.some((p) => p.id === s.paneId),
  )
  const naming = usePaneRenameStore((s) => s.splitTabId === tab.id)
  return (
    <div
      style={{ '--split-segments': panes.length } as CSSProperties}
      className={cn(
        'pane-tab pane-split-tab',
        entering && 'motion-fade',
        selected && 'selected',
        dropMark && `drop-${dropMark}`,
      )}
      role="tab"
      tabIndex={-1}
      aria-selected={selected}
      aria-label={label}
      data-tab-id={tab.id}
      {...tabDragProps(tab.id, workspaceId, !renaming)}
      onKeyDown={moveSegmentFocus}
    >
      <SplitTabHead
        tab={tab}
        focusedId={selected ? focusedId : null}
        naming={naming}
        workspaceId={workspaceId}
      />
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
