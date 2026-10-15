import { type BrowserDevice, resized } from '@shared/browser/browserDevice'
import type { PickBox } from '@shared/browser/pick'
import type { RegionView } from '@shared/browser/regionCapture'
import type { Size } from './regionSelect'

export const DEVICE_STAGE_GAP = 16

export interface DeviceFrame {
  width: number
  height: number
  scale: number
}

export interface Zooms {
  app: number
  page: number
}

export function deviceFrame(device: BrowserDevice, stage: Size, zooms: Zooms): DeviceFrame {
  const ratio = zooms.page / zooms.app
  const width = device.width * ratio
  const height = device.height * ratio
  const roomWidth = stage.width - 2 * DEVICE_STAGE_GAP
  const roomHeight = stage.height - 2 * DEVICE_STAGE_GAP
  if (device.zoom === 'actual' || roomWidth <= 0 || roomHeight <= 0) {
    return { width, height, scale: 1 }
  }
  return { width, height, scale: Math.min(1, roomWidth / width, roomHeight / height) }
}

export interface DeviceDrag {
  device: BrowserDevice
  scale: number
  ratio: number
  right: boolean
  bottom: boolean
}

export function draggedDevice(drag: DeviceDrag, dx: number, dy: number): BrowserDevice {
  const perPixel = 1 / (drag.scale * drag.ratio)
  const width = drag.right ? drag.device.width + 2 * dx * perPixel : drag.device.width
  const height = drag.bottom ? drag.device.height + dy * perPixel : drag.device.height
  return resized(drag.device, width, height)
}

export function unscaledRegion(
  rect: PickBox,
  view: RegionView,
  scale: number,
): { rect: PickBox; view: RegionView } {
  return {
    rect: {
      x: rect.x / scale,
      y: rect.y / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    },
    view: { width: view.width / scale, height: view.height / scale },
  }
}
