export const VIEWER_SELECTION_PATH = '/~selection'
export const VIEWER_OPEN_PATH = '/~open'
export const VIEWER_EDIT_SOURCE_PATH = '/~edit-source'
export const VIEWER_FIND_KEYS_PATH = '/~find-keys'

export const VIEWER_TEXT_MAX = 256 * 1024
export const VIEWER_CSV_MAX = 256 * 1024
export const VIEWER_CELLS_MAX = 10_000
export const VIEWER_IMAGE_MAX = 25 * 1024 * 1024
export const VIEWER_FRAME_MAX = 16_384
export const VIEWER_OPEN_HREF_MAX = 4096
export const VIEWER_SELECTION_BODY_MAX = VIEWER_IMAGE_MAX + 4 * VIEWER_TEXT_MAX

export interface ViewerRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewerFrame {
  width: number
  height: number
}

export interface ViewerTextRange {
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
}

export type ViewerSelectionCapture =
  | { kind: 'image'; imageWidth: number; imageHeight: number; region: ViewerRect | null }
  | { kind: 'pdf-text'; firstPage: number; lastPage: number }
  | {
      kind: 'pdf-region'
      page: number
      pageWidth: number
      pageHeight: number
      region: ViewerRect | null
    }
  | { kind: 'text'; view: 'preview'; range: ViewerTextRange }
  | { kind: 'cells'; sheet: string; range: string; rows: number; columns: number }

export interface ViewerSelectionMeta {
  capture: ViewerSelectionCapture
  rect: ViewerRect
  frame: ViewerFrame
  text?: string
  html?: string
  csv?: string
}

export interface ViewerSelectionBody {
  meta: unknown
  png: Uint8Array | null
}

const LENGTH_BYTES = 4

export function encodeViewerSelection(meta: ViewerSelectionMeta, png: BlobPart | null): Blob {
  const json = new TextEncoder().encode(JSON.stringify(meta))
  const length = new Uint8Array(LENGTH_BYTES)
  new DataView(length.buffer).setUint32(0, json.byteLength)
  return new Blob(png === null ? [length, json] : [length, json, png])
}

export function decodeViewerSelection(body: Uint8Array): ViewerSelectionBody | null {
  if (body.byteLength < LENGTH_BYTES) return null
  const jsonLength = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0)
  const jsonEnd = LENGTH_BYTES + jsonLength
  if (jsonEnd > body.byteLength) return null
  try {
    const meta: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(LENGTH_BYTES, jsonEnd)),
    )
    return { meta, png: jsonEnd < body.byteLength ? body.subarray(jsonEnd) : null }
  } catch {
    return null
  }
}
