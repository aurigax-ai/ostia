import {
  clearSelection,
  hasPublishedSelection,
  publishSelection,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { type Box, dragBox, fitBox, nativeRegion, type Point } from './frameCrop'

const DRAG_START_PIXELS = 4

async function framePng(video: HTMLVideoElement, region: Box): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = region.width
  canvas.height = region.height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(
    video,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    region.width,
    region.height,
  )
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

export interface FrameCapture {
  clear: () => void
  captureWholeFrame: () => void
}

export function attachFrameCapture(
  stage: HTMLElement,
  surface: HTMLElement,
  video: HTMLVideoElement,
  onClick: () => void,
): FrameCapture {
  const crop = document.createElement('div')
  crop.className = 'ostia-media-crop'
  crop.hidden = true
  stage.append(crop)
  let generation = 0

  const media = (): { width: number; height: number } => ({
    width: video.videoWidth,
    height: video.videoHeight,
  })
  const shown = (): Box => {
    const rect = stage.getBoundingClientRect()
    return fitBox({ width: rect.width, height: rect.height }, media())
  }
  const local = (event: PointerEvent): Point => {
    const rect = stage.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const draw = (box: Box): void => {
    crop.hidden = false
    crop.style.left = `${box.x}px`
    crop.style.top = `${box.y}px`
    crop.style.width = `${box.width}px`
    crop.style.height = `${box.height}px`
  }
  const clear = (): void => {
    generation++
    crop.hidden = true
    if (hasPublishedSelection()) void clearSelection()
  }
  const publish = async (selection: Box, region: Box | null): Promise<void> => {
    const ticket = ++generation
    const { width, height } = media()
    const png = await framePng(video, region ?? { x: 0, y: 0, width, height })
    if (!png || ticket !== generation) return
    await publishSelection({
      capture: { kind: 'image', imageWidth: width, imageHeight: height, region },
      rect: selection,
      png,
    })
  }

  let start: Point | null = null
  let dragging = false
  surface.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    start = local(event)
    dragging = false
    surface.setPointerCapture(event.pointerId)
  })
  surface.addEventListener('pointermove', (event) => {
    if (!start) return
    const point = local(event)
    if (!dragging && Math.hypot(point.x - start.x, point.y - start.y) < DRAG_START_PIXELS) {
      return
    }
    if (!dragging) {
      dragging = true
      if (hasPublishedSelection()) void clearSelection()
      video.pause()
    }
    const box = dragBox(start, point, shown())
    if (box) draw(box)
    else crop.hidden = true
  })
  const finish = (event: PointerEvent): void => {
    if (!start) return
    const from = start
    const wasDragging = dragging
    start = null
    dragging = false
    if (!wasDragging) {
      if (!crop.hidden) clear()
      else onClick()
      return
    }
    const box = dragBox(from, local(event), shown())
    if (!box) {
      clear()
      return
    }
    draw(box)
    const region = nativeRegion(box, shown(), media())
    if (region) void publish(box, region)
  }
  surface.addEventListener('pointerup', finish)
  surface.addEventListener('pointercancel', () => {
    start = null
    dragging = false
  })
  video.addEventListener('play', clear)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !crop.hidden) clear()
  })

  return {
    clear,
    captureWholeFrame: () => {
      if (hasPublishedSelection() || video.videoWidth === 0) return
      void publish(shown(), null)
    },
  }
}
