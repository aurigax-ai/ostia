import {
  decodeViewerSelection,
  VIEWER_CSV_MAX,
  VIEWER_FRAME_MAX,
  VIEWER_IMAGE_MAX,
  VIEWER_TEXT_MAX,
} from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'
import {
  isPng,
  needsImage,
  normalizeSelection,
  type SelectionCapture,
} from '../../../shared/browser/selection'
import type { ViewerSelectionState } from '../../../shared/files/filesApi'

export interface StoredSelection {
  capture: SelectionCapture
  text: string | null
  html: string | null
  csv: string | null
  png: Uint8Array | null
  anchor: ViewerSelectionState['anchor']
  seq: number
}

const GUEST_KINDS = new Set(['image', 'pdf-text', 'pdf-region', 'text', 'cells'])
const PNG_HEADER_TYPE_AT = 12
const PNG_DIMENSIONS_AT = 16
const PNG_SIDE_MAX = 16_384
const PNG_PIXELS_MAX = PNG_SIDE_MAX * PNG_SIDE_MAX
const PNG_HEADER_TYPE = [0x49, 0x48, 0x44, 0x52]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bounded(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > max) return undefined
  return value.length === 0 ? null : value
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function between(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function anchorOf(
  rect: unknown,
  frame: unknown,
): { left: number; top: number; bottom: number } | null {
  if (!isRecord(rect) || !isRecord(frame)) return null
  const [x, y, width, height] = [rect.x, rect.y, rect.width, rect.height].map(finite)
  const [frameWidth, frameHeight] = [frame.width, frame.height].map(finite)
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    frameWidth === null ||
    frameHeight === null
  ) {
    return null
  }
  const maxX = between(frameWidth, 1, VIEWER_FRAME_MAX)
  const maxY = between(frameHeight, 1, VIEWER_FRAME_MAX)
  const left = between(x, 0, maxX)
  const top = between(y, 0, maxY)
  const bottom = top + between(height, 0, maxY - top)
  return { left: Math.round(left), top: Math.round(top), bottom: Math.round(bottom) }
}

function pngIsSane(png: Uint8Array): boolean {
  if (!isPng(png) || png.byteLength > VIEWER_IMAGE_MAX || png.byteLength < PNG_DIMENSIONS_AT + 8) {
    return false
  }
  if (!PNG_HEADER_TYPE.every((byte, i) => png[PNG_HEADER_TYPE_AT + i] === byte)) return false
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const width = view.getUint32(PNG_DIMENSIONS_AT)
  const height = view.getUint32(PNG_DIMENSIONS_AT + 4)
  return (
    width > 0 &&
    height > 0 &&
    width <= PNG_SIDE_MAX &&
    height <= PNG_SIDE_MAX &&
    width * height <= PNG_PIXELS_MAX
  )
}

export function acceptGuestSelection(
  body: Uint8Array,
  file: string,
  seq: number,
): StoredSelection | null {
  const decoded = decodeViewerSelection(body)
  if (!decoded || !isRecord(decoded.meta) || !isRecord(decoded.meta.capture)) return null
  const { meta } = decoded
  const guestCapture = meta.capture as Record<string, unknown>
  if (typeof guestCapture.kind !== 'string' || !GUEST_KINDS.has(guestCapture.kind)) return null
  const text = bounded(meta.text, VIEWER_TEXT_MAX)
  const html = bounded(meta.html, VIEWER_TEXT_MAX)
  const csv = bounded(meta.csv, VIEWER_CSV_MAX)
  const anchor = anchorOf(meta.rect, meta.frame)
  if (text === undefined || html === undefined || csv === undefined || !anchor) return null
  const capture = normalizeSelection({
    ...guestCapture,
    file,
    view: 'preview',
    text: text ?? undefined,
    csv: csv ?? undefined,
  })
  if (!capture) return null
  let png: Uint8Array | null = null
  if (needsImage(capture)) {
    if (!decoded.png || !pngIsSane(decoded.png)) return null
    png = decoded.png.slice()
  }
  return { capture, text, html, csv, png, anchor, seq }
}

export function selectionState(stored: StoredSelection): ViewerSelectionState {
  return {
    capture: stored.capture,
    hasImage: stored.png !== null,
    hasText: stored.text !== null || stored.csv !== null,
    anchor: stored.anchor,
    seq: stored.seq,
  }
}
