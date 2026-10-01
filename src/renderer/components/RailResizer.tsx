import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import {
  RAIL_DEFAULT_WIDTH,
  RAIL_MIN_WIDTH,
  applyRailWidth,
  clampRailWidth,
  railDragResult,
  railKeyWidth,
  railMaxWidth,
  storeRailWidth,
  storedRailWidth,
} from '../lib/railWidth'
import { useUIStore } from '../stores/uiStore'

export const RAIL_ID = 'deck-rail'
const RESIZING_ATTRIBUTE = 'data-rail-resizing'

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

interface DragStart {
  pointerId: number
  x: number
  width: number
}

export function RailResizer(): JSX.Element | null {
  const d = useDict()
  const collapsed = useUIStore((s) => s.railCollapsed)
  const viewport = useViewportWidth()
  const [preferred, setPreferred] = useState(storedRailWidth)
  const [drag, setDrag] = useState<DragStart | null>(null)
  const latest = useRef(preferred)
  latest.current = preferred
  const width = clampRailWidth(preferred, viewport)

  useLayoutEffect(() => {
    applyRailWidth(width)
  }, [width])

  useEffect(() => {
    if (!drag) return
    document.documentElement.setAttribute(RESIZING_ATTRIBUTE, '')
    return () => document.documentElement.removeAttribute(RESIZING_ATTRIBUTE)
  }, [drag])

  const commit = (next: number): void => {
    setPreferred(next)
    storeRailWidth(next)
  }

  const endDrag = (): void => {
    if (!drag) return
    setDrag(null)
    storeRailWidth(latest.current)
  }

  if (collapsed && !drag) return null
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={d.rail.resize}
      aria-controls={RAIL_ID}
      aria-valuenow={width}
      aria-valuemin={RAIL_MIN_WIDTH}
      aria-valuemax={railMaxWidth(viewport)}
      className={`rail-resizer${collapsed ? ' collapsed' : ''}`}
      data-dragging={drag ? '' : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        e.currentTarget.focus()
        setDrag({ pointerId: e.pointerId, x: e.clientX, width })
      }}
      onPointerMove={(e) => {
        if (!drag || e.pointerId !== drag.pointerId) return
        const result = railDragResult(drag.width, e.clientX - drag.x, viewport)
        latest.current = result.width
        setPreferred(result.width)
        if (result.collapsed !== useUIStore.getState().railCollapsed) {
          useUIStore.getState().setRailCollapsed(result.collapsed)
        }
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => commit(RAIL_DEFAULT_WIDTH)}
      onKeyDown={(e) => {
        const next = railKeyWidth(e.key, width, viewport)
        if (next === null) return
        e.preventDefault()
        commit(next)
      }}
    />
  )
}
