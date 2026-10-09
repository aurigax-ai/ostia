import { fmt, useDict } from '@/i18n/useDict'
import { blockSpan, commandLine, stickyBlock } from '@/lib/blocks'
import { createCellBoxCache } from '@/lib/cellBox'
import type { OstiaTerminal as Xterm } from '@/lib/ostiaTerminal'
import { terminalScreen } from '@/lib/ostiaTerminal'
import { useExitPresence } from '@/lib/useExitPresence'
import { useBlocksStore } from '@/stores/blocksStore'
import { throttle } from 'es-toolkit'
import {
  type RefObject,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { BlockMenu } from './BlockMenu'

interface Bar {
  id: string
  top: number
  height: number
  attn: boolean
}

interface Frame {
  top: number
  height: number
}

export interface StickyInfo {
  blockId: string
  command: string
  running: boolean
  exitCode: number | null
  line: number
}

interface Geometry {
  bars: Bar[]
  live: Bar | null
  frame: Frame | null
  trackFrame: Frame | null
  sticky: StickyInfo | null
  view: Frame | null
}

const MAX_BARS = 80
export const RECOMPUTE_MS = 100
const EMPTY: Geometry = {
  bars: [],
  live: null,
  frame: null,
  trackFrame: null,
  sticky: null,
  view: null,
}

export function Blocks({
  paneId,
  termRef,
  hostRef,
  shown,
}: {
  paneId: string
  termRef: RefObject<Xterm | null>
  hostRef: RefObject<HTMLDivElement | null>
  shown: boolean
}): JSX.Element | null {
  const d = useDict()
  const [geo, setGeo] = useState<Geometry>(EMPTY)
  const trackRef = useRef<HTMLDivElement>(null)
  const scroll = useRef({ viewportY: 0, cellHeight: 0 })
  const blocks = useBlocksStore((s) => s.byPane[paneId])
  const selectedId = useBlocksStore((s) => s.selected[paneId])

  const placeTrack = useCallback((): void => {
    const track = trackRef.current
    if (!track) return
    const { viewportY, cellHeight } = scroll.current
    track.style.transform = `translateY(${-viewportY * cellHeight}px)`
  }, [])

  useLayoutEffect(placeTrack)

  // biome-ignore lint/correctness/useExhaustiveDependencies: blocks and selectedId drive recompute
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!shown || !term || !host) return

    const cells = createCellBoxCache(host, () => term.rows)
    const recompute = (): void => {
      const state = useBlocksStore.getState()
      const list = state.byPane[paneId]
      const buf = term.buffer.active
      const box = list && list.length > 0 && buf.type !== 'alternate' ? cells.get() : null
      if (!list || !box) {
        setGeo((prev) => (prev === EMPTY ? prev : EMPTY))
        return
      }
      const { cellHeight, originTop } = box
      const viewportY = buf.viewportY
      const cursorLine = buf.baseY + buf.cursorY
      scroll.current = { viewportY, cellHeight }
      placeTrack()
      const toViewport = (start: number, end: number): Frame | null => {
        const startRow = Math.max(0, start - viewportY)
        const endRow = Math.min(term.rows, end - viewportY)
        if (endRow <= startRow) return null
        return { top: originTop + startRow * cellHeight, height: (endRow - startRow) * cellHeight }
      }
      const toTrack = (start: number, end: number): Frame | null => {
        if (end <= viewportY - term.rows || start >= viewportY + 2 * term.rows) return null
        return { top: start * cellHeight, height: (end - start) * cellHeight }
      }
      const bars: Bar[] = []
      let live: Bar | null = null
      for (const b of list.slice(-MAX_BARS)) {
        const span = blockSpan(b, cursorLine)
        if (span.end <= 0) continue
        const running = b.endLine === null
        const box = (running ? toViewport : toTrack)(span.start, span.end)
        if (!box) continue
        const bar = { id: b.id, ...box, attn: (b.exitCode ?? 0) !== 0 }
        if (running) live = bar
        else bars.push(bar)
      }
      const selected = state.selected[paneId]
      const selectedBlock = selected ? list.find((b) => b.id === selected) : undefined
      const selectedSpan = selectedBlock ? blockSpan(selectedBlock, cursorLine) : null
      const selectedRunning = selectedBlock?.endLine === null
      const frame =
        selectedSpan && selectedRunning ? toViewport(selectedSpan.start, selectedSpan.end) : null
      const trackFrame =
        selectedSpan && !selectedRunning ? toTrack(selectedSpan.start, selectedSpan.end) : null
      const top = stickyBlock(list, viewportY, cursorLine)
      const sticky: StickyInfo | null = top?.command
        ? {
            blockId: top.id,
            command: top.command,
            running: top.endLine === null,
            exitCode: top.exitCode,
            line: commandLine(top),
          }
        : null
      const view = { top: originTop, height: term.rows * cellHeight }
      setGeo((prev) => {
        const next: Geometry = {
          bars: sameBars(prev.bars, bars) ? prev.bars : bars,
          live: sameBar(prev.live, live) ? prev.live : live,
          frame: sameBox(prev.frame, frame) ? prev.frame : frame,
          trackFrame: sameBox(prev.trackFrame, trackFrame) ? prev.trackFrame : trackFrame,
          sticky: sameSticky(prev.sticky, sticky) ? prev.sticky : sticky,
          view: sameBox(prev.view, view) ? prev.view : view,
        }
        return sameGeometry(prev, next) ? prev : next
      })
    }

    recompute()

    const throttled = throttle(recompute, RECOMPUTE_MS)
    const scrolled = (): void => {
      scroll.current = { ...scroll.current, viewportY: term.buffer.active.viewportY }
      placeTrack()
      throttled()
    }
    const remeasure = (): void => {
      throttled.cancel()
      cells.invalidate()
      recompute()
    }
    const offRender = term.onRender(throttled)
    const offScroll = term.onScroll(scrolled)
    const offResize = term.onResize(remeasure)
    const boxObserver = new ResizeObserver(remeasure)
    boxObserver.observe(host)
    const screen = terminalScreen(host)
    if (screen) boxObserver.observe(screen)
    return () => {
      throttled.cancel()
      offRender.dispose()
      offScroll.dispose()
      offResize.dispose()
      boxObserver.disconnect()
    }
  }, [paneId, blocks, selectedId, termRef, hostRef, shown, placeTrack])

  const sticky = useExitPresence(geo.sticky)

  const selectBlock = useCallback(
    (blockId: string): void => {
      const s = useBlocksStore.getState()
      s.select(paneId, s.selected[paneId] === blockId ? null : blockId)
      termRef.current?.focus()
    },
    [paneId, termRef],
  )

  const focusTerminal = useCallback((): void => termRef.current?.focus(), [termRef])

  if (geo.bars.length === 0 && !geo.live && !sticky.shown) return null

  const jumpTo = (line: number): void => {
    const term = termRef.current
    if (!term) return
    term.scrollToLine(Math.max(0, line))
    term.focus()
  }

  const gutter = (b: Bar): JSX.Element => (
    <GutterBar
      key={b.id}
      paneId={paneId}
      id={b.id}
      top={b.top}
      height={b.height}
      attn={b.attn}
      selected={b.id === selectedId}
      label={d.blocks.select}
      onSelect={selectBlock}
      onClosed={focusTerminal}
    />
  )

  const frameOf = (box: Frame): JSX.Element => (
    <div
      key={selectedId}
      className="block-frame"
      style={{ top: box.top, height: box.height }}
      aria-hidden="true"
    />
  )

  return (
    <div className="blocks-overlay">
      {geo.view && (
        <div className="blocks-lines" style={{ top: geo.view.top, height: geo.view.height }}>
          <div ref={trackRef} className="blocks-track">
            {geo.trackFrame && frameOf(geo.trackFrame)}
            {geo.bars.map(gutter)}
          </div>
        </div>
      )}
      {geo.frame && frameOf(geo.frame)}
      {geo.live && gutter(geo.live)}
      {sticky.shown && (
        <StickyHeader
          info={sticky.shown}
          onJump={jumpTo}
          leaving={sticky.leaving}
          onExited={sticky.onExited}
        />
      )}
    </div>
  )
}

const GutterBar = memo(function GutterBar({
  paneId,
  id,
  top,
  height,
  attn,
  selected,
  label,
  onSelect,
  onClosed,
}: Bar & {
  paneId: string
  selected: boolean
  label: string
  onSelect: (blockId: string) => void
  onClosed: () => void
}): JSX.Element {
  return (
    <BlockMenu
      paneId={paneId}
      blockId={id}
      onClosed={onClosed}
      trigger={
        <button
          type="button"
          className={`block-gutter${selected ? ' selected' : ''}`}
          style={{ top, height }}
          tabIndex={-1}
          aria-label={label}
          aria-pressed={selected}
          data-block-id={id}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(id)}
        >
          <span className={`block-bar${attn ? ' attn' : ''}`} />
        </button>
      }
    />
  )
})

export function StickyHeader({
  info,
  onJump,
  leaving = false,
  onExited,
}: {
  info: StickyInfo
  onJump: (line: number) => void
  leaving?: boolean
  onExited?: () => void
}): JSX.Element {
  const d = useDict()
  const failed = !info.running && (info.exitCode ?? 0) !== 0
  const status = info.running
    ? d.blocks.running
    : info.exitCode === null
      ? null
      : fmt(d.blocks.exitCode, { code: info.exitCode })
  return (
    <button
      type="button"
      className={`block-sticky${failed ? ' attn' : ''}${leaving ? ' leaving' : ''}`}
      aria-hidden={leaving || undefined}
      tabIndex={leaving ? -1 : undefined}
      onAnimationEnd={leaving ? onExited : undefined}
      aria-label={fmt(d.blocks.jumpToCommandFor, { command: info.command })}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onJump(info.line)}
    >
      <span className="block-sticky-command">{info.command}</span>
      {status && (
        <span className={`block-sticky-status${info.running ? ' running' : ''}`}>{status}</span>
      )}
    </button>
  )
}

function sameBox(a: Frame | null, b: Frame | null): boolean {
  return a === b || (a !== null && b !== null && a.top === b.top && a.height === b.height)
}

function sameSticky(a: StickyInfo | null, b: StickyInfo | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.blockId === b.blockId &&
    a.command === b.command &&
    a.running === b.running &&
    a.exitCode === b.exitCode &&
    a.line === b.line
  )
}

function sameBar(a: Bar | null, b: Bar | null): boolean {
  if (a === null || b === null) return a === b
  return a.id === b.id && a.attn === b.attn && sameBox(a, b)
}

function sameBars(a: Bar[], b: Bar[]): boolean {
  return a.length === b.length && a.every((bar, i) => sameBar(bar, b[i]))
}

function sameGeometry(a: Geometry, b: Geometry): boolean {
  return (
    a.bars === b.bars &&
    a.live === b.live &&
    a.frame === b.frame &&
    a.trackFrame === b.trackFrame &&
    a.sticky === b.sticky &&
    a.view === b.view
  )
}
