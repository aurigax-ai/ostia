import type { ViewerRect } from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'

export async function cropToPng(source: HTMLImageElement, rect: ViewerRect): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(rect.width))
  canvas.height = Math.max(1, Math.round(rect.height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no 2d canvas context')
  context.drawImage(
    source,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('could not encode PNG')
  return blob
}
