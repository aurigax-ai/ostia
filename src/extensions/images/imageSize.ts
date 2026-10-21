import type { Size } from './imageZoom'

export interface MeasuredImage {
  naturalWidth: number
  naturalHeight: number
  width: number
  height: number
}

export const DEFAULT_IMAGE_SIZE: Size = { width: 300, height: 150 }

const VIEW_BOX = /\bviewBox\s*=\s*["']\s*([^"']+)["']/i

export function svgViewBoxSize(source: string): Size | null {
  const match = VIEW_BOX.exec(source)
  if (!match) return null
  const parts = match[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null
  const [, , width, height] = parts
  return width > 0 && height > 0 ? { width, height } : null
}

export function resolveImageSize(measured: MeasuredImage, viewBox: Size | null): Size {
  if (measured.naturalWidth > 0 && measured.naturalHeight > 0) {
    return { width: measured.naturalWidth, height: measured.naturalHeight }
  }
  if (measured.width > 0 && measured.height > 0) {
    return { width: measured.width, height: measured.height }
  }
  return viewBox ?? DEFAULT_IMAGE_SIZE
}
