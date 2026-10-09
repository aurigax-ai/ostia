import type { PaneNode, SurfaceKind } from '@/layout/types'
import { mountSurface, parkSurface } from '@/stores/surfaceSlotsStore'
import { useCallback, useLayoutEffect, useRef } from 'react'

function hasSurface(kind: SurfaceKind): boolean {
  return kind !== 'agent'
}

export function TabBody({ pane, shown }: { pane: PaneNode; shown: boolean }): JSX.Element | null {
  const slotEl = useRef<HTMLDivElement | null>(null)
  const slotRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (slotEl.current) parkSurface(pane.id, slotEl.current)
      slotEl.current = el
      if (el) mountSurface(pane.id, el)
    },
    [pane.id],
  )
  useLayoutEffect(() => {
    if (slotEl.current) slotEl.current.inert = !shown
  }, [shown])

  if (!hasSurface(pane.kind)) {
    return shown ? (
      <div className="pane-slot pane-slot-ghost">
        <span className="ghost">{pane.title}</span>
      </div>
    ) : null
  }
  return <div className="pane-slot" data-hidden={shown ? undefined : ''} ref={slotRef} />
}
