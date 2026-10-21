import { useCallback, useLayoutEffect, useRef } from 'react'
import type { PaneNode } from '@/lib/layout/types'
import { mountSurface, parkSurface } from '@/stores/workspaces/surfaceSlotsStore'

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

  return <div className="pane-slot" data-hidden={shown ? undefined : ''} ref={slotRef} />
}
