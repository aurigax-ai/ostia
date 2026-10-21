import type { ViewerRect } from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'
import type { Size } from './imageZoom'

export async function rasterizeRegion(
  source: HTMLImageElement,
  natural: Size,
  region: ViewerRect,
  output: Size,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = output.width
  canvas.height = output.height
  const context = canvas.getContext('2d')
  if (!context) return null
  const across = output.width / region.width
  const down = output.height / region.height
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    source,
    -region.x * across,
    -region.y * down,
    natural.width * across,
    natural.height * down,
  )
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
}
