import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { liveLogicalLines, showHistoryAboveLive } from '@/lib/terminal/historyActions'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react'
import { type RefObject, useEffect, useRef, useState } from 'react'

const WHEEL_OPENS_AFTER_MS = 300

export function HistoryEdge({
  paneId,
  termRef,
  hostRef,
  shown,
}: {
  paneId: string
  termRef: RefObject<OstiaTerminal | null>
  hostRef: RefObject<HTMLDivElement | null>
  shown: boolean
}): JSX.Element | null {
  const d = useDict()
  const gen = useBlocksStore((s) => s.gen[paneId])
  const [earlier, setEarlier] = useState(0)
  const shownAt = useRef(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: gen marks a fresh attach
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!shown || !term || !host) return
    let live = true
    let asking = false
    let count = 0
    const update = (next: number): void => {
      if (next > 0 && count === 0) shownAt.current = Date.now()
      count = next
      setEarlier(next)
    }
    const check = (): void => {
      const buf = term.buffer.active
      if (buf.type !== 'normal' || buf.viewportY > 0 || buf.baseY === 0) {
        update(0)
        return
      }
      if (asking) return
      asking = true
      void window.ostia.pty.historyRead(paneId, 0, 0).then((page) => {
        asking = false
        if (!live) return
        update(page ? Math.max(0, page.end - page.first - liveLogicalLines(term)) : 0)
      })
    }
    let frame = 0
    const onWheel = (e: WheelEvent): void => {
      const atTop = term.buffer.active.viewportY === 0
      if (e.deltaY < 0 && atTop && count > 0) {
        if (Date.now() - shownAt.current >= WHEEL_OPENS_AFTER_MS) showHistoryAboveLive(paneId, term)
        return
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(check)
    }
    check()
    const sub = term.onScroll(check)
    host.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      live = false
      cancelAnimationFrame(frame)
      sub.dispose()
      host.removeEventListener('wheel', onWheel)
    }
  }, [paneId, termRef, hostRef, shown, gen])

  if (earlier <= 0) return null
  return (
    <div className="history-edge" data-history-edge="">
      <ClockCounterClockwiseIcon aria-hidden className="size-4 shrink-0 text-fg-muted" />
      <span className="text-ui-xs text-fg-muted tabular-nums">
        {fmt(d.scrollHistory.edge, { count: earlier.toLocaleString() })}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => {
          const term = termRef.current
          if (term) showHistoryAboveLive(paneId, term)
        }}
      >
        {d.scrollHistory.show}
      </Button>
    </div>
  )
}
