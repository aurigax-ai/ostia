import { clip } from './pick'

export interface TextRange {
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
}

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

export type SelectionCapture =
  | { kind: 'text'; file: string; view: 'source' | 'preview'; range: TextRange; text: string }
  | { kind: 'image'; file: string; imageWidth: number; imageHeight: number; region: Region | null }
  | { kind: 'pdf-text'; file: string; firstPage: number; lastPage: number; text: string }
  | {
      kind: 'pdf-region'
      file: string
      page: number
      pageWidth: number
      pageHeight: number
      region: Region | null
    }
  | { kind: 'terminal'; cwd: string | null; command: string | null; text: string }
  | { kind: 'preview-error'; file: string; count: number; text: string }

export const SELECTION_COMMAND_MAX = 2000

export interface SelectionSendRequest {
  capture: SelectionCapture
  image?: Uint8Array
  sourcePaneId: string
  targetPaneId: string
  note: string
}

export type SelectionSendError = 'invalid' | 'not-found' | 'image-too-large' | 'write-failed'

export type SelectionSendResult =
  | { ok: true; path: string; imagePath: string | null }
  | { ok: false; error: SelectionSendError }

export const SELECTION_TEXT_MAX = 50_000
export const SELECTION_PATH_MAX = 4096
export const SELECTION_NOTE_MAX = 4000
export const SELECTION_IMAGE_MAX = 25 * 1024 * 1024
export const PREVIEW_ERROR_MAX = 8 * 1024

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

export function needsImage(capture: SelectionCapture): boolean {
  return capture.kind === 'image' || capture.kind === 'pdf-region'
}

function count(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

function size(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

function offset(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

function normalizeRegion(value: unknown): Region | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object') return undefined
  const r = value as Record<string, unknown>
  const x = offset(r.x)
  const y = offset(r.y)
  const width = size(r.width)
  const height = size(r.height)
  if (x === null || y === null || width === null || height === null) return undefined
  return { x, y, width, height }
}

function normalizeRange(value: unknown): TextRange | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const startLine = count(r.startLine)
  const endLine = count(r.endLine)
  if (startLine === null || endLine === null || endLine < startLine) return null
  const startColumn = count(r.startColumn)
  const endColumn = count(r.endColumn)
  return startColumn !== null && endColumn !== null
    ? { startLine, endLine, startColumn, endColumn }
    : { startLine, endLine }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? clip(value, SELECTION_TEXT_MAX) : null
}

function normalizeTerminal(c: Record<string, unknown>): SelectionCapture | null {
  const body = text(c.text)
  if (body === null) return null
  const cwd =
    typeof c.cwd === 'string' && ABSOLUTE_PATH.test(c.cwd) ? clip(c.cwd, SELECTION_PATH_MAX) : null
  const command =
    typeof c.command === 'string' && c.command.length > 0
      ? clip(c.command, SELECTION_COMMAND_MAX)
      : null
  return { kind: 'terminal', cwd, command, text: body }
}

export function normalizeSelection(value: unknown): SelectionCapture | null {
  if (!value || typeof value !== 'object') return null
  const c = value as Record<string, unknown>
  if (c.kind === 'terminal') return normalizeTerminal(c)
  if (typeof c.file !== 'string' || !ABSOLUTE_PATH.test(c.file)) return null
  const file = clip(c.file, SELECTION_PATH_MAX)
  switch (c.kind) {
    case 'text': {
      const range = normalizeRange(c.range)
      const body = text(c.text)
      if (!range || body === null) return null
      const view = c.view === 'preview' ? 'preview' : 'source'
      return { kind: 'text', file, view, range, text: body }
    }
    case 'image': {
      const imageWidth = count(c.imageWidth)
      const imageHeight = count(c.imageHeight)
      const region = normalizeRegion(c.region)
      if (imageWidth === null || imageHeight === null || region === undefined) return null
      return { kind: 'image', file, imageWidth, imageHeight, region }
    }
    case 'pdf-text': {
      const firstPage = count(c.firstPage)
      const lastPage = count(c.lastPage)
      const body = text(c.text)
      if (firstPage === null || lastPage === null || lastPage < firstPage || body === null) {
        return null
      }
      return { kind: 'pdf-text', file, firstPage, lastPage, text: body }
    }
    case 'pdf-region': {
      const page = count(c.page)
      const pageWidth = size(c.pageWidth)
      const pageHeight = size(c.pageHeight)
      const region = normalizeRegion(c.region)
      if (page === null || pageWidth === null || pageHeight === null || region === undefined) {
        return null
      }
      return { kind: 'pdf-region', file, page, pageWidth, pageHeight, region }
    }
    case 'preview-error': {
      const errors = count(c.count)
      const body = text(c.text)
      if (errors === null || body === null) return null
      return { kind: 'preview-error', file, count: errors, text: clip(body, PREVIEW_ERROR_MAX) }
    }
    default:
      return null
  }
}

function baseName(path: string): string {
  return path.split('/').pop() || path
}

function lineSpan(range: TextRange): string {
  if (range.startColumn !== undefined && range.endColumn !== undefined) {
    return `${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn}`
  }
  return range.startLine === range.endLine
    ? `${range.startLine}`
    : `${range.startLine}-${range.endLine}`
}

function pageSpan(first: number, last: number): string {
  return first === last ? `page ${first}` : `pages ${first}-${last}`
}

function regionText(region: Region): string {
  return `x ${region.x}, y ${region.y}, ${region.width} × ${region.height}`
}

function firstLine(value: string): string {
  return value.split('\n', 1)[0]
}

export function selectionLabel(capture: SelectionCapture): string {
  if (capture.kind === 'terminal') {
    return capture.command ? `$ ${firstLine(capture.command)}` : 'Terminal selection'
  }
  const name = baseName(capture.file)
  switch (capture.kind) {
    case 'text':
      return `${name}:${lineSpan(capture.range)}`
    case 'image':
      return capture.region ? `${name} (${regionText(capture.region)})` : name
    case 'pdf-text':
      return `${name}, ${pageSpan(capture.firstPage, capture.lastPage)}`
    case 'pdf-region':
      return `${name}, page ${capture.page}${capture.region ? ` (${regionText(capture.region)})` : ''}`
    case 'preview-error':
      return `${name}, ${capture.count} ${capture.count === 1 ? 'error' : 'errors'}`
  }
}

function fence(body: string, lang = ''): string {
  let ticks = '```'
  while (body.includes(ticks)) ticks += '`'
  return `${ticks}${lang}\n${body}\n${ticks}`
}

function fenceLang(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path)
  return match ? match[1].toLowerCase() : ''
}

function title(capture: SelectionCapture): string {
  switch (capture.kind) {
    case 'text':
      return 'Text selection'
    case 'image':
      return capture.region ? 'Image region' : 'Image'
    case 'pdf-text':
      return 'PDF text selection'
    case 'pdf-region':
      return capture.region ? 'PDF page region' : 'PDF page'
    case 'terminal':
      return capture.command ? 'Terminal output' : 'Terminal text'
    case 'preview-error':
      return 'Preview error'
  }
}

function sourceLines(capture: SelectionCapture, imagePath: string | null): string[] {
  const snapshot = `- Snapshot: ${imagePath ?? '(none)'}`
  switch (capture.kind) {
    case 'text': {
      const where =
        capture.view === 'preview'
          ? `${lineSpan(capture.range)} (source lines of the block selected in the Markdown preview)`
          : `${lineSpan(capture.range)} (line:column, 1-based, end exclusive)`
      return [`- Lines: ${where}`]
    }
    case 'image':
      return [
        `- Image size: ${capture.imageWidth} × ${capture.imageHeight} px`,
        `- Region: ${capture.region ? `${regionText(capture.region)} (image px, origin top-left)` : 'whole image'}`,
        snapshot,
      ]
    case 'pdf-text':
      return [
        `- Pages: ${capture.firstPage === capture.lastPage ? capture.firstPage : `${capture.firstPage}-${capture.lastPage}`} (1-based)`,
      ]
    case 'pdf-region':
      return [
        `- Page: ${capture.page} (1-based), ${capture.pageWidth} × ${capture.pageHeight} pt`,
        `- Region: ${capture.region ? `${regionText(capture.region)} (PDF points, origin top-left)` : 'whole page'}`,
        snapshot,
      ]
    case 'terminal':
      return [
        `- Directory: ${capture.cwd ?? '(unknown)'}`,
        ...(capture.command ? [`- Command: ${capture.command}`] : []),
      ]
    case 'preview-error':
      return [
        `- Errors: ${capture.count} (console errors of the page running in Ostia's preview, newest last)`,
        '- The preview has no network; a line starting with "blocked" names a host the page tried to reach',
      ]
  }
}

export function renderSelectionReport(
  capture: SelectionCapture,
  note: string,
  imagePath: string | null,
  capturedAt: Date,
): string {
  const lines: string[] = []
  const trimmedNote = clip(note.trim(), SELECTION_NOTE_MAX)
  lines.push(`# ${title(capture)}: ${selectionLabel(capture)}`, '')
  lines.push('## Note', '', trimmedNote || '(no note)', '')
  lines.push('## Source', '')
  if (capture.kind !== 'terminal') lines.push(`- File: ${capture.file}`)
  lines.push(...sourceLines(capture, imagePath))
  lines.push(`- Captured: ${capturedAt.toISOString()}`, '')
  if (capture.kind === 'terminal') {
    lines.push('## Terminal text', '', fence(capture.text), '')
  } else if (capture.kind === 'preview-error') {
    lines.push('## Errors', '', fence(capture.text), '')
  } else if (capture.kind === 'text' || capture.kind === 'pdf-text') {
    const lang = capture.kind === 'text' && capture.view === 'source' ? fenceLang(capture.file) : ''
    lines.push('## Selected text', '', fence(capture.text, lang), '')
  }
  return lines.join('\n')
}

export interface SelectionBusMessage {
  kind: 'selection'
  report: string
  file: string | null
  image: string | null
  note: string
}

export function selectionBusMessage(
  capture: SelectionCapture,
  note: string,
  report: string,
  imagePath: string | null,
): string {
  const message: SelectionBusMessage = {
    kind: 'selection',
    report,
    file: capture.kind === 'terminal' ? null : capture.file,
    image: imagePath,
    note: clip(note.trim(), SELECTION_NOTE_MAX),
  }
  return JSON.stringify(message)
}
