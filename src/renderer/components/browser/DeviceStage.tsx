import { zoomFactor } from '@shared/app/zoom'
import { type BrowserDevice, RESPONSIVE } from '@shared/browser/browserDevice'
import { devicePreset } from '@shared/browser/devicePresets'
import type { DeviceTouch } from '@shared/browser/deviceTouch'
import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef } from 'react'
import { useElementSize } from '@/lib/app/useElementSize'
import { type DeviceDrag, deviceFrame, draggedDevice } from '@/lib/browser/deviceFrame'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { DeviceTouchLayer } from './DeviceTouchLayer'

type Edge = 'right' | 'bottom' | 'corner'

const EDGES: readonly Edge[] = ['right', 'bottom', 'corner']

interface DragStart extends DeviceDrag {
  x: number
  y: number
  latest: BrowserDevice
}

export function DeviceStage({
  device,
  onPreview,
  onCommit,
  onTouch,
  onFocusPage,
  overlay,
  children,
}: {
  device: BrowserDevice | undefined
  onPreview: (next: BrowserDevice) => void
  onCommit: (next: BrowserDevice) => void
  onTouch: (input: DeviceTouch) => void
  onFocusPage: () => void
  overlay: (scale: number) => ReactNode
  children: ReactNode
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const stage = useElementSize(stageRef)
  const appZoom = useSettingsStore((s) => zoomFactor(s.appearance.zoom))
  const pageZoom = useSettingsStore((s) => s.browser.defaultZoom / 100)
  const dragRef = useRef<DragStart | null>(null)
  const frame = device ? deviceFrame(device, stage, { app: appZoom, page: pageZoom }) : null
  const ratio = pageZoom / appZoom
  const touch = device ? (devicePreset(device.preset)?.touch ?? false) : false

  const onPointerDown = (edge: Edge) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !device || !frame) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = {
      device,
      latest: device,
      scale: frame.scale,
      ratio,
      right: edge !== 'bottom',
      bottom: edge !== 'right',
      x: e.clientX,
      y: e.clientY,
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    drag.latest = draggedDevice(drag, e.clientX - drag.x, e.clientY - drag.y)
    onPreview(drag.latest)
  }
  const onPointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag) onCommit(drag.latest)
  }

  return (
    <div ref={stageRef} className="browser-device-stage" data-device={device ? '' : undefined}>
      <div
        className="browser-device-viewport"
        style={
          frame
            ? { width: frame.width * frame.scale, height: frame.height * frame.scale }
            : undefined
        }
      >
        <div
          className="browser-device-screen"
          style={
            frame
              ? { width: frame.width, height: frame.height, transform: `scale(${frame.scale})` }
              : undefined
          }
        >
          {children}
        </div>
        {frame && touch ? (
          <DeviceTouchLayer scale={frame.scale} onTouch={onTouch} onFocusPage={onFocusPage} />
        ) : null}
        {overlay(frame?.scale ?? 1)}
        {device?.preset === RESPONSIVE
          ? EDGES.map((edge) => (
              <div
                key={edge}
                aria-hidden="true"
                className="browser-device-handle"
                data-edge={edge}
                onPointerDown={onPointerDown(edge)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            ))
          : null}
      </div>
    </div>
  )
}
