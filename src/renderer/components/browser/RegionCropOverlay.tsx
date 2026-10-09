import { type Point, dragRegion } from '@/lib/browser/regionSelect'
import type { PickBox } from '@shared/browser/pick'
import { REGION_MIN, type RegionView } from '@shared/browser/regionCapture'
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'

export interface RegionCropOverlayProps {
  label: string
  onDone: (rect: PickBox, view: RegionView) => void
  onCancel: () => void
}

function viewOf(el: HTMLElement): RegionView {
  const box = el.getBoundingClientRect()
  return { width: box.width, height: box.height }
}

function pointOf(e: ReactPointerEvent<HTMLElement>): Point {
  const box = e.currentTarget.getBoundingClientRect()
  return { x: e.clientX - box.left, y: e.clientY - box.top }
}

export function RegionCropOverlay({
  label,
  onDone,
  onCancel,
}: RegionCropOverlayProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const startRef = useRef<Point | null>(null)
  const [rect, setRect] = useState<PickBox | null>(null)

  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])

  const track = (e: ReactPointerEvent<HTMLDivElement>): PickBox | null => {
    const start = startRef.current
    if (!start) return null
    const next = dragRegion(start, pointOf(e), viewOf(e.currentTarget))
    setRect(next)
    return next
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    onCancel()
  }

  return (
    <div
      ref={ref}
      role="application"
      aria-label={label}
      tabIndex={-1}
      className="region-crop-layer region-select"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.focus({ preventScroll: true })
        e.currentTarget.setPointerCapture?.(e.pointerId)
        startRef.current = pointOf(e)
        setRect(null)
      }}
      onPointerMove={track}
      onPointerUp={(e) => {
        const done = track(e)
        startRef.current = null
        if (done && done.width >= REGION_MIN && done.height >= REGION_MIN) {
          onDone(done, viewOf(e.currentTarget))
        } else {
          setRect(null)
        }
      }}
    >
      {rect ? (
        <div
          className="region-crop-box"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        >
          <output className="region-crop-size">
            {rect.width} × {rect.height}
          </output>
        </div>
      ) : null}
    </div>
  )
}
