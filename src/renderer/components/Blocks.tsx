import type { Terminal as Xterm } from '@xterm/xterm'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { useBlocksStore } from '../stores/blocksStore'

/** A left-edge accent bar for one command block, in pixels within the xterm host. */
interface Bar {
  id: string
  top: number
  height: number
  attn: boolean
}

/** Bars are cheap to draw; cap how many we bother positioning per pane. */
const MAX_BARS = 80

/**
 * Warp-style command-block overlay: a thin left-edge accent per command, red when it
 * exited non-zero. Purely decorative and `pointer-events: none` — if line→pixel mapping
 * can't be trusted (host not laid out, cell height unmeasurable) it renders nothing rather
 * than a misaligned bar, so a bug here can never break the terminal underneath.
 */
export function Blocks({
  paneId,
  termRef,
  hostRef,
}: {
  paneId: string
  termRef: RefObject<Xterm | null>
  hostRef: RefObject<HTMLDivElement | null>
}): JSX.Element | null {
  const [bars, setBars] = useState<Bar[]>([])
  const wiredRef = useRef(false)
  const blocks = useBlocksStore((s) => s.byPane[paneId])

  // `blocks` isn't read directly below (recompute re-fetches fresh state so the
  // onRender/onScroll listeners — wired once — never see a stale snapshot), but its
  // identity change is exactly the "new block data landed" signal that should recompute.
  // biome-ignore lint/correctness/useExhaustiveDependencies: blocks drives recompute, see above
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host) return

    const recompute = (): void => {
      // Re-read from the store (not the `blocks` closure) so the onRender/onScroll listeners
      // below — wired once — always see the latest blocks, not a stale snapshot from mount.
      const list = useBlocksStore.getState().byPane[paneId]
      if (!list || list.length === 0) {
        setBars((prev) => (prev.length === 0 ? prev : []))
        return
      }
      // While a full-screen app owns the screen (vim/less/htop → alternate buffer), normal
      // buffer line numbers don't advance, so bars would collapse/mis-map. Hide them.
      if (term.buffer.active.type === 'alternate') {
        setBars((prev) => (prev.length === 0 ? prev : []))
        return
      }
      const cellHeight = measureCellHeight(host)
      if (!cellHeight) {
        // Can't trust the mapping yet (e.g. xterm hasn't painted a row) — degrade to
        // nothing rather than guess and risk misaligned bars.
        setBars((prev) => (prev.length === 0 ? prev : []))
        return
      }
      const viewportY = term.buffer.active.viewportY
      const cursorLine = term.buffer.active.baseY + term.buffer.active.cursorY
      const next: Bar[] = []
      for (const b of list.slice(-MAX_BARS)) {
        const endLine = b.endLine ?? cursorLine
        const startRow = b.outputStartLine - viewportY
        const endRow = endLine - viewportY
        if (endRow < 0 || startRow > term.rows) continue // fully scrolled off-screen
        const top = Math.max(0, startRow) * cellHeight
        const bottom = Math.min(term.rows, endRow + 1) * cellHeight
        if (bottom <= top) continue
        next.push({ id: b.id, top, height: bottom - top, attn: (b.exitCode ?? 0) !== 0 })
      }
      setBars(next)
    }

    recompute()

    if (wiredRef.current) return
    wiredRef.current = true
    const offRender = term.onRender(recompute)
    const offScroll = term.onScroll(recompute)
    return () => {
      offRender.dispose()
      offScroll.dispose()
      wiredRef.current = false
    }
  }, [paneId, blocks, termRef, hostRef])

  if (bars.length === 0) return null

  return (
    <div className="blocks-overlay" aria-hidden="true">
      {bars.map((b) => (
        <span
          key={b.id}
          className={`block-bar${b.attn ? ' attn' : ''}`}
          style={{ top: b.top, height: b.height }}
        />
      ))}
    </div>
  )
}

/** The rendered height of one row, measured from xterm's own DOM (accounts for font/line-height). */
function measureCellHeight(host: HTMLElement): number {
  const row = host.querySelector('.xterm-rows > div') as HTMLElement | null
  return row?.offsetHeight ?? 0
}
