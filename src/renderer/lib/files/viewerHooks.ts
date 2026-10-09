import {
  type Point,
  type Size,
  type ZoomAnchor,
  anchoredScroll,
  dragRegion,
  pinchZoom,
  toContentPoint,
} from '@/lib/browser/regionSelect'
import type { Region } from '@shared/browser/selection'
import type { FsBinaryResult } from '@shared/types'
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

export type FileBytes = { status: 'loading' } | FsBinaryResult

export function useFileBytes(path: string | undefined): FileBytes {
  const [bytes, setBytes] = useState<FileBytes>({ status: 'loading' })
  useEffect(() => {
    setBytes({ status: 'loading' })
    if (!path) return
    let alive = true
    window.ostia.fs.readBinary(path).then(
      (res) => {
        if (alive) setBytes(res)
      },
      () => {
        if (alive) setBytes({ ok: false, error: 'unreadable' })
      },
    )
    return () => {
      alive = false
    }
  }, [path])
  return bytes
}

export function useElementSize(ref: RefObject<HTMLElement>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const width = el.clientWidth
      const height = el.clientHeight
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

export interface RegionDrag {
  region: Region | null
  enabled: boolean
  clear: () => void
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  }
}

export function useRegionDrag(opts: { scale: number; bounds: Size; enabled: boolean }): RegionDrag {
  const [region, setRegion] = useState<Region | null>(null)
  const startRef = useRef<Point | null>(null)
  const clear = useCallback(() => setRegion(null), [])

  const pointOf = (e: ReactPointerEvent<HTMLElement>): Point =>
    toContentPoint(
      { x: e.clientX, y: e.clientY },
      e.currentTarget.getBoundingClientRect(),
      opts.scale,
    )

  const track = (e: ReactPointerEvent<HTMLElement>): void => {
    const start = startRef.current
    if (start) setRegion(dragRegion(start, pointOf(e), opts.bounds))
  }

  return {
    region,
    enabled: opts.enabled,
    clear,
    handlers: {
      onPointerDown: (e) => {
        if (!opts.enabled || e.button !== 0) return
        e.preventDefault()
        e.currentTarget.focus({ preventScroll: true })
        e.currentTarget.setPointerCapture?.(e.pointerId)
        startRef.current = pointOf(e)
        setRegion(null)
      },
      onPointerMove: track,
      onPointerUp: (e) => {
        track(e)
        startRef.current = null
      },
    },
  }
}

export function usePinchZoom(opts: {
  stageRef: RefObject<HTMLElement>
  contentRef: RefObject<HTMLElement>
  scale: number
  onZoom: (scale: number) => void
}): void {
  const { stageRef, contentRef, scale } = opts
  const scaleRef = useRef(scale)
  const anchorRef = useRef<ZoomAnchor | null>(null)
  const onZoomRef = useRef(opts.onZoom)
  onZoomRef.current = opts.onZoom

  useLayoutEffect(() => {
    scaleRef.current = scale
    const anchor = anchorRef.current
    anchorRef.current = null
    const stage = stageRef.current
    const content = contentRef.current
    if (!anchor || !stage || !content) return
    const next = anchoredScroll(
      { x: stage.scrollLeft, y: stage.scrollTop },
      anchor,
      content.getBoundingClientRect(),
      scale,
    )
    stage.scrollLeft = next.x
    stage.scrollTop = next.y
  }, [scale, stageRef, contentRef])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const content = contentRef.current
      if (!content) return
      const current = scaleRef.current
      const next = pinchZoom(current, e.deltaY)
      if (next === current) return
      const client = { x: e.clientX, y: e.clientY }
      const point =
        anchorRef.current?.content ??
        toContentPoint(client, content.getBoundingClientRect(), current)
      anchorRef.current = { content: point, client }
      scaleRef.current = next
      onZoomRef.current(next)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [stageRef, contentRef])
}

export function useSettled<T>(value: T | null, delayMs: number): T | null {
  const [settled, setSettled] = useState(value)
  if (settled === null && value !== null) setSettled(value)
  useEffect(() => {
    if (Object.is(value, settled)) return
    const timer = window.setTimeout(() => setSettled(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, settled, delayMs])
  return settled ?? value
}
