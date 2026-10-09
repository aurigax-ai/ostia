import { commands } from '@/commands/registry'
import { Hint } from '@/components/common/Hint'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fmt, useDict } from '@/i18n/useDict'
import { allPanes, firstPaneId } from '@/layout/tree'
import type { PaneNode, SplitNode, TabNode } from '@/layout/types'
import { tabMark } from '@/lib/attention/attention'
import { type HiddenTabs, hiddenTabs, revealScroll } from '@/lib/panes/tabRow'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { focusSurface } from '@/stores/workspaces/surfaceSlotsStore'
import { CaretDownIcon } from '@phosphor-icons/react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { SplitTabGlyph } from './SplitTab'
import { TabFace, usePaneMark } from './TabFace'

const NOTHING_HIDDEN: HiddenTabs = { start: [], end: [] }

function panesOf(tab: TabNode): PaneNode[] {
  return tab.type === 'pane' ? [tab] : allPanes(tab)
}

function tabElement(row: HTMLElement, id: string): HTMLElement | null {
  return row.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)
}

function reveal(row: HTMLElement, id: string): void {
  const tab = tabElement(row, id)
  if (!tab) return
  row.scrollLeft = revealScroll(row.scrollLeft, row.clientWidth, tab.offsetLeft, tab.offsetWidth)
}

function freezeWidths(row: HTMLElement): void {
  const loose = [...row.querySelectorAll<HTMLElement>('[data-tab-id]:not([data-frozen])')]
  const widths = loose.map((tab) => tab.getBoundingClientRect().width)
  loose.forEach((tab, i) => {
    tab.style.flex = 'none'
    tab.style.width = `${widths[i]}px`
    tab.dataset.frozen = ''
  })
}

function thawWidths(row: HTMLElement): void {
  for (const tab of row.querySelectorAll<HTMLElement>('[data-frozen]')) {
    tab.style.flex = ''
    tab.style.width = ''
    delete tab.dataset.frozen
  }
}

function sameHidden(a: HiddenTabs, b: HiddenTabs): boolean {
  return a.start.join(' ') === b.start.join(' ') && a.end.join(' ') === b.end.join(' ')
}

export function TabRow({
  tabs,
  shownTabId,
  label,
  onNewTab,
  children,
}: {
  tabs: TabNode[]
  shownTabId: string
  label: string
  onNewTab: () => void
  children: ReactNode
}): JSX.Element {
  const d = useDict()
  const rowRef = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState<HiddenTabs>(NOTHING_HIDDEN)
  const [fade, setFade] = useState({ start: false, end: false })
  const tabKey = tabs.map((t) => t.id).join(' ')
  const markedKey = useAttentionStore((s) =>
    tabs
      .filter((t) => panesOf(t).some((p) => tabMark(s.byPane[p.id]) !== null))
      .map((t) => t.id)
      .join(' '),
  )
  const marked = useMemo(() => new Set(markedKey.split(' ')), [markedKey])

  const measure = useCallback(() => {
    const row = rowRef.current
    if (!row) return
    const view = row.getBoundingClientRect()
    const spans = [...row.querySelectorAll<HTMLElement>('[data-tab-id]')].map((tab) => {
      const rect = tab.getBoundingClientRect()
      return { id: tab.dataset.tabId ?? '', left: rect.left, right: rect.right }
    })
    const next = hiddenTabs(view, spans)
    setHidden((prev) => (sameHidden(prev, next) ? prev : next))
    const start = row.scrollLeft > 0
    const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1
    setFade((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [])

  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row || !tabKey) return
    reveal(row, shownTabId)
    measure()
  }, [shownTabId, tabKey, measure])

  useEffect(() => {
    const row = rowRef.current
    if (!row) return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [measure])

  const hiddenStart = hidden.start.filter((id) => marked.has(id))
  const hiddenEnd = hidden.end.filter((id) => marked.has(id))
  const overflowing = hidden.start.length + hidden.end.length > 0

  const edgeMark = (edge: 'start' | 'end', ids: string[]) => {
    if (ids.length === 0) return null
    const text = fmt(d.pane.hiddenAttention, { count: ids.length })
    return (
      <Hint label={text} side="bottom">
        <button
          type="button"
          className="pane-tabs-attn"
          data-edge={edge}
          aria-label={text}
          onClick={() => {
            const row = rowRef.current
            const id = edge === 'start' ? ids[ids.length - 1] : ids[0]
            if (row && id) reveal(row, id)
          }}
        >
          <span className="pane-attn-mark" aria-hidden />
          {ids.length}
        </button>
      </Hint>
    )
  }

  return (
    <>
      <div
        className="pane-tab-row"
        onPointerDown={() => rowRef.current && freezeWidths(rowRef.current)}
        onPointerLeave={() => {
          if (!rowRef.current) return
          thawWidths(rowRef.current)
          measure()
        }}
      >
        <div
          ref={rowRef}
          className="pane-tabs"
          role="tablist"
          aria-label={label}
          data-fade-start={fade.start ? '' : undefined}
          data-fade-end={fade.end ? '' : undefined}
          onScroll={measure}
          onWheel={(e) => {
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
            e.currentTarget.scrollLeft += e.deltaY
          }}
          onDoubleClick={(e) => {
            if (e.target === e.currentTarget) onNewTab()
          }}
        >
          {children}
        </div>
        {edgeMark('start', hiddenStart)}
        {edgeMark('end', hiddenEnd)}
      </div>
      {overflowing ? (
        <AllTabs
          tabs={tabs}
          shownTabId={shownTabId}
          onPick={(tab) => {
            const paneId = firstPaneId(tab)
            void commands.exec('pane.focus', { paneId })
            requestAnimationFrame(() => focusSurface(paneId))
            if (rowRef.current) reveal(rowRef.current, tab.id)
          }}
        />
      ) : null}
    </>
  )
}

function AllTabs({
  tabs,
  shownTabId,
  onPick,
}: {
  tabs: TabNode[]
  shownTabId: string
  onPick: (tab: TabNode) => void
}): JSX.Element {
  const d = useDict()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="xs" className="pane-all-tabs">
            {d.pane.allTabs}
            <CaretDownIcon data-icon="inline-end" />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 p-0">
        <Command label={d.pane.allTabs}>
          <CommandInput placeholder={d.pane.searchTabs} aria-label={d.pane.searchTabs} />
          <CommandList>
            <CommandEmpty>{d.pane.noTabsFound}</CommandEmpty>
            {tabs.map((tab) => (
              <AllTabsItem
                key={tab.id}
                tab={tab}
                current={tab.id === shownTabId}
                onPick={() => {
                  setOpen(false)
                  onPick(tab)
                }}
              />
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function AllTabsItem({
  tab,
  current,
  onPick,
}: {
  tab: TabNode
  current: boolean
  onPick: () => void
}): JSX.Element {
  return tab.type === 'pane' ? (
    <PaneItem pane={tab} current={current} onPick={onPick} />
  ) : (
    <SplitItem tab={tab} current={current} onPick={onPick} />
  )
}

function PaneItem({
  pane,
  current,
  onPick,
}: {
  pane: PaneNode
  current: boolean
  onPick: () => void
}): JSX.Element {
  const mark = usePaneMark(pane)
  return (
    <CommandItem
      value={`${pane.title} ${pane.id}`}
      className="all-tabs-item"
      data-attention={mark ?? undefined}
      data-current={current ? '' : undefined}
      onSelect={onPick}
    >
      <TabFace pane={pane} />
    </CommandItem>
  )
}

function SplitItem({
  tab,
  current,
  onPick,
}: {
  tab: SplitNode
  current: boolean
  onPick: () => void
}): JSX.Element {
  const mark = useAttentionStore((s) =>
    allPanes(tab)
      .map((p) => tabMark(s.byPane[p.id]))
      .find((m) => m !== null),
  )
  const titles = allPanes(tab)
    .map((p) => p.title)
    .join(' | ')
  const name = tab.name ?? titles
  return (
    <CommandItem
      value={`${tab.name ?? ''} ${titles} ${tab.id}`}
      className="all-tabs-item"
      data-attention={mark ?? undefined}
      data-current={current ? '' : undefined}
      onSelect={onPick}
    >
      <SplitTabGlyph tab={tab} focusedId={null} />
      {mark ? <span className="pane-attn-mark" aria-hidden /> : null}
      <span className="title">{name}</span>
    </CommandItem>
  )
}
