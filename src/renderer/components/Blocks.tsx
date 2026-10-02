import type { Terminal as Xterm } from '@xterm/xterm'
import { type RefObject, useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { blockSpan, commandLine, stickyBlock } from '../lib/blocks'
import { createCellBoxCache } from '../lib/cellBox'
import { useExitPresence } from '../lib/useExitPresence'
import { useBlocksStore } from '../stores/blocksStore'
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
  frame: Frame | null
  sticky: StickyInfo | null
}

const MAX_BARS = 80
const EMPTY: Geometry = { bars: [], frame: null, sticky: null }

export function Blocks({
  paneId,
  termRef,
  hostRef,
}: {
  paneId: string
  termRef: RefObject<Xterm | null>
  hostRef: RefObject<HTMLDivElement | null>
}): JSX.Element | null {
  const d = useDict()
  const [geo, setGeo] = useState<Geometry>(EMPTY)
  const blocks = useBlocksStore((s) => s.byPane[paneId])
  const selectedId = useBlocksStore((s) => s.selected[paneId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: blocks and selectedId drive recompute
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host) return

    const cells = createCellBoxCache(host)
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
      const toBox = (start: number, end: number): Frame | null => {
        const startRow = Math.max(0, start - viewportY)
        const endRow = Math.min(term.rows, end - viewportY)
        if (endRow <= startRow) return null
        return { top: originTop + startRow * cellHeight, height: (endRow - startRow) * cellHeight }
      }
      const bars: Bar[] = []
      for (const b of list.slice(-MAX_BARS)) {
        const span = blockSpan(b, cursorLine)
        if (span.end <= 0) continue
        const box = toBox(span.start, span.end)
        if (box) bars.push({ id: b.id, ...box, attn: (b.exitCode ?? 0) !== 0 })
      }
      const selected = state.selected[paneId]
      const selectedBlock = selected ? list.find((b) => b.id === selected) : undefined
      const frame = selectedBlock
        ? (() => {
            const span = blockSpan(selectedBlock, cursorLine)
            return toBox(span.start, span.end)
          })()
        : null
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
      const next: Geometry = { bars, frame, sticky }
      setGeo((prev) => (sameGeometry(prev, next) ? prev : next))
    }

    recompute()

    const remeasure = (): void => {
      cells.invalidate()
      recompute()
    }
    const offRender = term.onRender(recompute)
    const offScroll = term.onScroll(recompute)
    const offResize = term.onResize(remeasure)
    const boxObserver = new ResizeObserver(remeasure)
    boxObserver.observe(host)
    const screen = host.querySelector('.xterm-screen')
    if (screen) boxObserver.observe(screen)
    return () => {
      offRender.dispose()
      offScroll.dispose()
      offResize.dispose()
      boxObserver.disconnect()
    }
  }, [paneId, blocks, selectedId, termRef, hostRef])

  const sticky = useExitPresence(geo.sticky)

  if (geo.bars.length === 0 && !sticky.shown) return null

  const selectBlock = (blockId: string): void => {
    const s = useBlocksStore.getState()
    s.select(paneId, s.selected[paneId] === blockId ? null : blockId)
    termRef.current?.focus()
  }

  const jumpTo = (line: number): void => {
    const term = termRef.current
    if (!term) return
    term.scrollToLine(Math.max(0, line))
    term.focus()
  }

  return (
    <div className="blocks-overlay">
      {geo.frame && (
        <div
          key={selectedId}
          className="block-frame"
          style={{ top: geo.frame.top, height: geo.frame.height }}
          aria-hidden="true"
        />
      )}
      {geo.bars.map((b) => (
        <BlockMenu
          key={b.id}
          paneId={paneId}
          blockId={b.id}
          onClosed={() => termRef.current?.focus()}
          trigger={
            <button
              type="button"
              className={`block-gutter${b.id === selectedId ? ' selected' : ''}`}
              style={{ top: b.top, height: b.height }}
              tabIndex={-1}
              aria-label={d.blocks.select}
              aria-pressed={b.id === selectedId}
              data-block-id={b.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectBlock(b.id)}
            >
              <span className={`block-bar${b.attn ? ' attn' : ''}`} />
            </button>
          }
        />
      ))}
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
      aria-label={`${d.blocks.jumpToCommand}: ${info.command}`}
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

function sameGeometry(a: Geometry, b: Geometry): boolean {
  return (
    a.bars.length === b.bars.length &&
    a.bars.every((bar, i) => {
      const other = b.bars[i]
      return bar.id === other.id && bar.attn === other.attn && sameBox(bar, other)
    }) &&
    sameBox(a.frame, b.frame) &&
    sameSticky(a.sticky, b.sticky)
  )
}
