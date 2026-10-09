import type { Region } from '@shared/browser/selection'

export async function cropToPng(source: CanvasImageSource, rect: Region): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(rect.width))
  canvas.height = Math.max(1, Math.round(rect.height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas context')
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('could not encode PNG')
  return new Uint8Array(await blob.arrayBuffer())
}
