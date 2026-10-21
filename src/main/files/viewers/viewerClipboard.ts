import { fmt } from '../../../shared/app/dict'
import type { ClipboardCapture } from '../../../shared/keyboard/clipboardCapture'
import type { StoredSelection } from './viewerSelection'

export interface ViewerCopyStrings {
  cells: string
  image: string
  nothing: string
  text: string
  textAndImage: string
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch])
}

function csvRows(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]
    if (quoted) {
      if (ch !== '"') cell += ch
      else if (csv[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && csv[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function tableHtml(csv: string): string {
  const body = csvRows(csv)
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('')
  return `<table><tbody>${body}</tbody></table>`
}

export function clipboardOf(stored: StoredSelection): ClipboardCapture {
  const out: ClipboardCapture = {}
  const text = stored.csv ?? stored.text
  if (text !== null) out.text = text
  if (stored.csv !== null) out.html = tableHtml(stored.csv)
  else if (stored.html !== null) out.html = stored.html
  const imageToo = text === null || stored.capture.kind === 'pdf-region'
  if (stored.png && imageToo) out.png = stored.png
  return out
}

export function copyStatus(
  copied: ClipboardCapture,
  strings: ViewerCopyStrings,
  capture: StoredSelection['capture'],
): string {
  if (capture.kind === 'cells' && copied.text !== undefined) {
    return fmt(strings.cells, {
      range: capture.sheet ? `${capture.sheet}!${capture.range}` : capture.range,
      rows: capture.rows,
      columns: capture.columns,
    })
  }
  if (copied.png && copied.text !== undefined) return strings.textAndImage
  if (copied.png) return strings.image
  return copied.text === undefined ? strings.nothing : strings.text
}
