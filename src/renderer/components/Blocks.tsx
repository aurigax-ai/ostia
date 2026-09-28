import type { Terminal as Xterm } from '@xterm/xterm'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { useBlocksStore } from '../stores/blocksStore'

interface Bar {
  id: string
  top: number
  height: number
  attn: boolean
}

const MAX_BARS = 80

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: blocks drives recompute, see above
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host) return

    const recompute = (): void => {
      const list = useBlocksStore.getState().byPane[paneId]
      if (!list || list.length === 0) {
        setBars((prev) => (prev.length === 0 ? prev : []))
        return
      }
      if (term.buffer.active.type === 'alternate') {
        setBars((prev) => (prev.length === 0 ? prev : []))
        return
      }
      const cellHeight = measureCellHeight(host)
      if (!cellHeight) {
        setBars((prev) => (prev.length === 0 ? prev : []))
        return
      }
      const viewportY = term.buffer.active.viewportY
      const cursorLine = term.buffer.active.baseY + term.buffer.active.cursorY
      const next: Bar[] = []
      for (const b of list.slice(-MAX_BARS)) {
        const endLine = b.endLine ? b.endLine.line : cursorLine
        if (endLine < 0) continue
        const startRow = b.outputStartLine.line - viewportY
        const endRow = endLine - viewportY
        if (endRow < 0 || startRow > term.rows) continue
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

function measureCellHeight(host: HTMLElement): number {
  const row = host.querySelector('.xterm-rows > div') as HTMLElement | null
  return row?.offsetHeight ?? 0
}
