import {
  type PanelWidthSpec,
  applyPanelWidth,
  clampPanelWidth,
  panelDragResult,
  panelKeyWidth,
  panelMaxWidth,
  storePanelWidth,
  storedPanelWidth,
} from '@/lib/panelWidth'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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

interface PanelResizerProps {
  spec: PanelWidthSpec
  label: string
  controls: string
  className: string
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

export function PanelResizer({
  spec,
  label,
  controls,
  className,
  collapsed = false,
  onCollapsedChange,
}: PanelResizerProps): JSX.Element | null {
  const viewport = useViewportWidth()
  const [preferred, setPreferred] = useState(() => storedPanelWidth(spec))
  const [drag, setDrag] = useState<DragStart | null>(null)
  const latest = useRef(preferred)
  latest.current = preferred
  const width = clampPanelWidth(spec, preferred, viewport)

  useLayoutEffect(() => {
    applyPanelWidth(spec, width)
  }, [spec, width])

  useEffect(() => {
    if (!drag) return
    document.documentElement.setAttribute(RESIZING_ATTRIBUTE, '')
    return () => document.documentElement.removeAttribute(RESIZING_ATTRIBUTE)
  }, [drag])

  const commit = (next: number): void => {
    setPreferred(next)
    storePanelWidth(spec, next)
  }

  const endDrag = (): void => {
    if (!drag) return
    setDrag(null)
    storePanelWidth(spec, latest.current)
  }

  if (collapsed && !drag) return null
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={spec.minWidth}
      aria-valuemax={panelMaxWidth(spec, viewport)}
      className={`panel-resizer ${className}${collapsed ? ' collapsed' : ''}`}
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
        const result = panelDragResult(spec, drag.width, e.clientX - drag.x, viewport)
        latest.current = result.width
        setPreferred(result.width)
        if (result.collapsed !== collapsed) onCollapsedChange?.(result.collapsed)
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => commit(spec.defaultWidth)}
      onKeyDown={(e) => {
        const next = panelKeyWidth(spec, e.key, width, viewport)
        if (next === null) return
        e.preventDefault()
        commit(next)
      }}
    />
  )
}
