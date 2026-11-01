import type { DeviceTouch } from '@shared/browser/deviceTouch'
import { type JSX, type PointerEvent as ReactPointerEvent, useEffect, useRef } from 'react'

type TouchPhase = 'touchMove' | 'touchEnd' | 'touchCancel'

export function DeviceTouchLayer({
  scale,
  onTouch,
  onFocusPage,
}: {
  scale: number
  onTouch: (input: DeviceTouch) => void
  onFocusPage: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const pointer = useRef<number | null>(null)

  const touch = (type: TouchPhase, e: ReactPointerEvent<HTMLDivElement>): void => {
    if (pointer.current !== e.pointerId) return
    if (type !== 'touchMove') pointer.current = null
    onTouch({ type, windowX: e.clientX, windowY: e.clientY })
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const box = el.getBoundingClientRect()
      onTouch({
        type: 'wheel',
        viewX: (e.clientX - box.left) / scale,
        viewY: (e.clientY - box.top) / scale,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scale, onTouch])

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="browser-device-touch"
      onPointerDown={(e) => {
        if (e.button !== 0 || pointer.current !== null) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        pointer.current = e.pointerId
        onFocusPage()
        onTouch({ type: 'touchStart', windowX: e.clientX, windowY: e.clientY })
      }}
      onPointerMove={(e) => touch('touchMove', e)}
      onPointerUp={(e) => touch('touchEnd', e)}
      onPointerCancel={(e) => touch('touchCancel', e)}
    />
  )
}
