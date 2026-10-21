/// <reference lib="dom" />
import { PICK_TABLE_CELLS_MAX } from '../browser/pick'

const SPAN_MAX = 1000
const SKIPPED_PARENTS = new Set(['script', 'style', 'noscript', 'template'])

export function createTableReader(win: Window & typeof globalThis) {
  const doc = win.document

  const cellText = (cell: Element): string => {
    const parts: string[] = []
    const walker = doc.createTreeWalker(cell, win.NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (parent && SKIPPED_PARENTS.has(parent.tagName.toLowerCase())) continue
      parts.push(node.textContent ?? '')
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim()
  }

  const tableOf = (el: Element): HTMLTableElement | null => el.closest('table')

  const rowsOf = (table: HTMLTableElement): string[][] => {
    const grid: string[][] = []
    const bodyRows = Array.from(table.rows)
    let cells = 0
    for (let r = 0; r < bodyRows.length && cells <= PICK_TABLE_CELLS_MAX; r++) {
      grid[r] ??= []
      let c = 0
      for (const cell of Array.from(bodyRows[r].cells)) {
        while (grid[r][c] !== undefined) c++
        const text = cellText(cell)
        const rowSpan = Math.max(1, Math.min(cell.rowSpan, bodyRows.length - r))
        const colSpan = Math.max(1, Math.min(cell.colSpan, SPAN_MAX))
        for (let dr = 0; dr < rowSpan; dr++) {
          grid[r + dr] ??= []
          for (let dc = 0; dc < colSpan; dc++) grid[r + dr][c + dc] = text
        }
        c += colSpan
        cells += rowSpan * colSpan
      }
    }
    const columns = Math.max(0, ...grid.map((row) => row.length))
    return grid.map((row) => Array.from({ length: columns }, (_, i) => row[i] ?? ''))
  }

  return { tableOf, rowsOf }
}
