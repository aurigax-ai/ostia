import {
  PICK_NOTE_MAX,
  PICK_TEXT_MAX,
  PICK_URL_MAX,
  type PickBox,
  clip,
  markdownImage,
} from './pick'
import { SELECTION_IMAGE_MAX } from './selection'

export interface RegionView {
  width: number
  height: number
}

export interface RegionCaptureRequest {
  rect: PickBox
  view: RegionView
}

export interface RegionCapture {
  id: string
  url: string
  title: string
  rect: PickBox
  imageWidth: number
  imageHeight: number
  capturedAt: string
}

export type RegionCaptureError = 'invalid' | 'browser-not-ready' | 'empty' | 'image-too-large'

export type RegionCaptureOutcome =
  | { ok: true; capture: RegionCapture }
  | { ok: false; error: RegionCaptureError }

export interface RegionSendRequest {
  captureId: string
  sourcePaneId: string
  targetPaneId: string
  note: string
}

export type RegionCopyResult = { ok: true } | { ok: false; error: 'capture-expired' | 'not-found' }

export const REGION_MIN = 4
export const REGION_VIEW_MAX = 16_384
export const REGION_IMAGE_MAX = SELECTION_IMAGE_MAX
const EDGE_TOLERANCE = 1

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function asView(raw: unknown): RegionView | null {
  if (!raw || typeof raw !== 'object') return null
  const { width, height } = raw as Record<string, unknown>
  if (!finiteNumber(width) || !finiteNumber(height)) return null
  if (width < REGION_MIN || height < REGION_MIN) return null
  if (width > REGION_VIEW_MAX || height > REGION_VIEW_MAX) return null
  return { width, height }
}

export function normalizeRegionRequest(raw: unknown): RegionCaptureRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const req = raw as Record<string, unknown>
  const view = asView(req.view)
  if (!view || !req.rect || typeof req.rect !== 'object') return null
  const { x, y, width, height } = req.rect as Record<string, unknown>
  if (!finiteNumber(x) || !finiteNumber(y) || !finiteNumber(width) || !finiteNumber(height)) {
    return null
  }
  if (x < -EDGE_TOLERANCE || y < -EDGE_TOLERANCE) return null
  if (x + width > view.width + EDGE_TOLERANCE || y + height > view.height + EDGE_TOLERANCE) {
    return null
  }
  const left = Math.max(0, Math.floor(x))
  const top = Math.max(0, Math.floor(y))
  const right = Math.min(Math.floor(view.width), Math.ceil(x + width))
  const bottom = Math.min(Math.floor(view.height), Math.ceil(y + height))
  if (right - left < REGION_MIN || bottom - top < REGION_MIN) return null
  return { rect: { x: left, y: top, width: right - left, height: bottom - top }, view }
}

function scaled(rect: PickBox, factor: number): PickBox {
  const left = Math.floor(rect.x * factor)
  const top = Math.floor(rect.y * factor)
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.ceil((rect.x + rect.width) * factor) - left),
    height: Math.max(1, Math.ceil((rect.y + rect.height) * factor) - top),
  }
}

function positive(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

export function regionCaptureRect(rect: PickBox, hostZoom: number): PickBox {
  return scaled(rect, positive(hostZoom))
}

export function regionPageRect(rect: PickBox, hostZoom: number, guestZoom: number): PickBox {
  const factor = positive(hostZoom) / positive(guestZoom)
  const round = (n: number): number => Math.round(n * factor * 100) / 100
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
  }
}

export interface RegionCaptureFacts {
  id: string
  url: string
  title: string
  rect: PickBox
  imageWidth: number
  imageHeight: number
  capturedAt: Date
}

export function regionCapture(facts: RegionCaptureFacts): RegionCapture {
  return {
    id: facts.id,
    url: clip(facts.url, PICK_URL_MAX),
    title: clip(facts.title, PICK_TEXT_MAX),
    rect: facts.rect,
    imageWidth: facts.imageWidth,
    imageHeight: facts.imageHeight,
    capturedAt: facts.capturedAt.toISOString(),
  }
}

function regionSize(rect: PickBox): string {
  return `${rect.width} × ${rect.height}`
}

export function renderRegionReport(
  capture: RegionCapture,
  note: string,
  imagePath: string,
): string {
  const trimmedNote = clip(note.trim(), PICK_NOTE_MAX)
  const r = capture.rect
  return [
    `# Captured region: ${capture.title || capture.url || 'page'} (${regionSize(r)} CSS px)`,
    '',
    '## Note',
    '',
    trimmedNote || '(no note)',
    '',
    '## Region',
    '',
    `- Page: ${capture.title ? `${capture.title} — ` : ''}${capture.url}`,
    `- Region: x ${r.x}, y ${r.y}, ${regionSize(r)} (CSS px, viewport)`,
    `- Screenshot: ${imagePath} (${capture.imageWidth} × ${capture.imageHeight} px)`,
    `- Captured: ${capture.capturedAt}`,
    '',
    '## Screenshot',
    '',
    markdownImage('Captured region', imagePath),
    '',
  ].join('\n')
}

export interface RegionBusMessage {
  kind: 'capture'
  report: string
  image: string
  url: string
  region: PickBox
  note: string
}

export function regionBusMessage(
  capture: RegionCapture,
  note: string,
  report: string,
  image: string,
): string {
  const message: RegionBusMessage = {
    kind: 'capture',
    report,
    image,
    url: capture.url,
    region: capture.rect,
    note: clip(note.trim(), PICK_NOTE_MAX),
  }
  return JSON.stringify(message)
}
