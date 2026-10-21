import { VIEWER_IMAGE_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'
import {
  clearSelection,
  hasPublishedSelection,
  onSelectionPublished,
  publishSelection,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { type Box, dragBox, fitBox, nativeRegion, type Point } from './frameCrop'
import {
  CAPTURE_ATTEMPTS,
  CAPTURE_SHRINK,
  captureFactor,
  type Size,
  scaledRegion,
  scaledSize,
} from './frameScale'

const DRAG_START_PIXELS = 4

async function framePng(video: HTMLVideoElement, region: Box, out: Size): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = out.width
  canvas.height = out.height
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
    out.width,
    out.height,
  )
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

async function encodeFrame(
  video: HTMLVideoElement,
  region: Box,
): Promise<{ png: Blob; factor: number } | null> {
  let factor = captureFactor(region)
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
    const png = await framePng(video, region, scaledSize(region, factor)).catch(() => null)
    if (png && png.size <= VIEWER_IMAGE_MAX) return { png, factor }
    factor *= CAPTURE_SHRINK
  }
  return null
}

export interface FrameCapture {
  clear: () => void
  selectWholeFrame: () => void
}

export function attachFrameCapture(
  stage: HTMLElement,
  surface: HTMLElement,
  video: HTMLVideoElement,
  onClick: () => void,
  onFailure: () => void,
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
  onSelectionPublished((published) => {
    if (published) return
    generation++
    crop.hidden = true
  })
  const publish = async (selection: Box, region: Box | null): Promise<void> => {
    const ticket = ++generation
    const frame = media()
    const encoded = await encodeFrame(video, region ?? { x: 0, y: 0, ...frame })
    if (ticket !== generation) return
    const image = encoded ? scaledSize(frame, encoded.factor) : null
    const published =
      encoded && image
        ? await publishSelection({
            capture: {
              kind: 'image',
              imageWidth: image.width,
              imageHeight: image.height,
              region: region ? scaledRegion(region, encoded.factor, image) : null,
            },
            rect: selection,
            png: encoded.png,
          })
        : false
    if (ticket !== generation || published) return
    clear()
    onFailure()
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
    selectWholeFrame: () => {
      if (video.videoWidth === 0) return
      video.pause()
      const box = shown()
      draw(box)
      void publish(box, null)
    },
  }
}
