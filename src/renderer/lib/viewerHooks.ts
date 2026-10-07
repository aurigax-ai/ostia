import type { Region } from '@shared/selection'
import type { FsBinaryResult } from '@shared/types'
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { type Point, type Size, dragRegion, toContentPoint } from './regionSelect'

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
