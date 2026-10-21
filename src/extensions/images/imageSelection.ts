import type { Translate } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import {
  VIEWER_IMAGE_MAX,
  type ViewerRect,
} from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'
import {
  clearSelection,
  onSelectionPublished,
  publishSelection,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { encodeWithin } from './imageCapture'
import { cropRect, pageRect } from './imageCrop'
import { rasterizeRegion } from './imageRaster'
import type { Point, Size } from './imageZoom'
import type { ZoomView } from './imageZoomView'

const STATUS_MS = 4000

export interface ImageSelection {
  select: (region: ViewerRect | null) => void
  deselect: () => void
  preview: (region: ViewerRect | null) => void
}

export function createSelection(parts: {
  image: HTMLImageElement
  natural: Size
  stage: HTMLElement
  canvas: HTMLElement
  region: HTMLElement
  status: HTMLElement
  view: ZoomView
  t: Translate
}): ImageSelection {
  const { image, natural, stage, canvas, region, status, view, t } = parts
  let selecting = false
  let selectedAt: Point = { x: 0, y: 0 }
  let token = 0
  let queue: Promise<void> = Promise.resolve()
  let statusTimer: ReturnType<typeof setTimeout> | undefined

  const enqueue = (operation: () => Promise<void>): void => {
    queue = queue.then(operation).catch(() => {})
  }

  const preview = (rect: ViewerRect | null): void => {
    region.hidden = rect === null
    if (!rect) return
    const factor = view.scale()
    region.style.left = `${rect.x * factor}px`
    region.style.top = `${rect.y * factor}px`
    region.style.width = `${rect.width * factor}px`
    region.style.height = `${rect.height * factor}px`
  }

  const showStatus = (text: string): void => {
    status.textContent = text
    status.hidden = false
    clearTimeout(statusTimer)
    statusTimer = setTimeout(() => {
      status.hidden = true
    }, STATUS_MS)
  }

  const deselect = (): void => {
    token++
    preview(null)
    if (!selecting) return
    selecting = false
    enqueue(() => clearSelection())
  }

  const publish = async (chosen: ViewerRect | null, current: () => boolean): Promise<boolean> => {
    const crop = cropRect(chosen, natural)
    const png = await encodeWithin(crop, VIEWER_IMAGE_MAX, (output) =>
      rasterizeRegion(image, natural, crop, output),
    ).catch(() => null)
    if (!current()) return true
    const rect =
      png &&
      pageRect(chosen, natural, canvas.getBoundingClientRect(), view.scale(), {
        width: window.innerWidth,
        height: window.innerHeight,
      })
    if (!png || !rect) return false
    return publishSelection({
      capture: {
        kind: 'image',
        imageWidth: natural.width,
        imageHeight: natural.height,
        region: chosen,
      },
      rect,
      png,
    })
  }

  const select = (chosen: ViewerRect | null): void => {
    const mine = ++token
    selecting = true
    selectedAt = { x: stage.scrollLeft, y: stage.scrollTop }
    preview(cropRect(chosen, natural))
    enqueue(async () => {
      if (mine !== token) return
      const published = await publish(chosen, () => mine === token)
      if (mine !== token || published) return
      deselect()
      showStatus(t('captureFailed'))
    })
  }

  onSelectionPublished((published) => {
    if (published || !selecting) return
    token++
    selecting = false
    preview(null)
  })
  stage.addEventListener('scroll', () => {
    if (stage.scrollLeft !== selectedAt.x || stage.scrollTop !== selectedAt.y) deselect()
  })
  view.onViewChange(deselect)
  return { select, deselect, preview }
}
