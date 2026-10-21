import { isPng, SELECTION_IMAGE_MAX } from '../browser/selection'

export const CLIPBOARD_TEXT_MAX = 256 * 1024

export interface ClipboardCapture {
  text?: string
  html?: string
  png?: Uint8Array
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}

function bounded(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) return null
  return value.length > CLIPBOARD_TEXT_MAX ? value.slice(0, CLIPBOARD_TEXT_MAX) : value
}

export function normalizeClipboardCapture(raw: unknown): ClipboardCapture | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const text = bounded(input.text)
  const html = bounded(input.html)
  if (text === null || html === null) return null
  const capture: ClipboardCapture = {}
  if (text !== undefined) capture.text = text
  if (html !== undefined) capture.html = html
  if (input.png !== undefined) {
    const png = asBytes(input.png)
    if (!png || !isPng(png) || png.byteLength > SELECTION_IMAGE_MAX) return null
    capture.png = png
  }
  return capture.text === undefined && capture.html === undefined && capture.png === undefined
    ? null
    : capture
}
