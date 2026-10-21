import type { ViewerRect } from '../contract/viewerSelection'
import { columnName } from './gridLayout'

export interface GridCell {
  row: number
  column: number
}

export interface GridRange {
  r1: number
  c1: number
  r2: number
  c2: number
}

export interface GridSize {
  rowCount: number
  columnCount: number
}

export type GridShape = 'cells' | 'columns' | 'rows'

export interface GridSelection {
  anchor: GridCell
  focus: GridCell
  shape: GridShape
}

export type GridKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'PageUp'
  | 'PageDown'
  | 'Home'
  | 'End'

export const GRID_KEYS: ReadonlySet<string> = new Set<GridKey>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

export function clampCell(cell: GridCell, size: GridSize): GridCell {
  return {
    row: clamp(cell.row, 0, Math.max(0, size.rowCount - 1)),
    column: clamp(cell.column, 0, Math.max(0, size.columnCount - 1)),
  }
}

export function rangeBetween(a: GridCell, b: GridCell): GridRange {
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.column, b.column),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.column, b.column),
  }
}

export function rangeRows(range: GridRange): number {
  return range.r2 - range.r1 + 1
}

export function rangeColumns(range: GridRange): number {
  return range.c2 - range.c1 + 1
}

export function rangeContains(range: GridRange, row: number, column: number): boolean {
  return row >= range.r1 && row <= range.r2 && column >= range.c1 && column <= range.c2
}

export function sameRange(a: GridRange | null, b: GridRange | null): boolean {
  if (a === null || b === null) return a === b
  return a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2
}

export function rangeLabel(range: GridRange, rowOffset = 0): string {
  const first = `${columnName(range.c1)}${range.r1 + 1 + rowOffset}`
  if (range.r1 === range.r2 && range.c1 === range.c2) return first
  return `${first}:${columnName(range.c2)}${range.r2 + 1 + rowOffset}`
}

export function selectionRange(selection: GridSelection, size: GridSize): GridRange {
  const { anchor, focus, shape } = selection
  if (shape === 'columns') {
    return {
      r1: 0,
      c1: Math.min(anchor.column, focus.column),
      r2: size.rowCount - 1,
      c2: Math.max(anchor.column, focus.column),
    }
  }
  if (shape === 'rows') {
    return {
      r1: Math.min(anchor.row, focus.row),
      c1: 0,
      r2: Math.max(anchor.row, focus.row),
      c2: size.columnCount - 1,
    }
  }
  return rangeBetween(anchor, focus)
}

export function activeCell(selection: GridSelection): GridCell {
  const { focus, shape } = selection
  if (shape === 'columns') return { row: 0, column: focus.column }
  if (shape === 'rows') return { row: focus.row, column: 0 }
  return focus
}

export function selectCell(cell: GridCell): GridSelection {
  return { anchor: cell, focus: cell, shape: 'cells' }
}

function asCells(selection: GridSelection, size: GridSize): GridSelection {
  if (selection.shape === 'cells') return selection
  const range = selectionRange(selection, size)
  return {
    anchor: { row: range.r1, column: range.c1 },
    focus: { row: range.r2, column: range.c2 },
    shape: 'cells',
  }
}

export function extendTo(
  selection: GridSelection | null,
  active: GridCell,
  cell: GridCell,
): GridSelection {
  if (!selection) return { anchor: active, focus: cell, shape: 'cells' }
  const anchor = selection.shape === 'cells' ? selection.anchor : activeCell(selection)
  return { anchor, focus: cell, shape: 'cells' }
}

export function selectHeader(
  shape: 'columns' | 'rows',
  index: number,
  extend: GridSelection | null,
): GridSelection {
  const cell = shape === 'columns' ? { row: 0, column: index } : { row: index, column: 0 }
  if (extend?.shape === shape) return { anchor: extend.anchor, focus: cell, shape }
  return { anchor: cell, focus: cell, shape }
}

export function selectAll(size: GridSize): GridSelection {
  return {
    anchor: { row: 0, column: 0 },
    focus: { row: Math.max(0, size.rowCount - 1), column: Math.max(0, size.columnCount - 1) },
    shape: 'cells',
  }
}

export interface MoveOptions {
  size: GridSize
  page: number
  ctrl: boolean
}

export function movedCell(from: GridCell, key: GridKey, options: MoveOptions): GridCell {
  const { size, page, ctrl } = options
  const last = { row: size.rowCount - 1, column: size.columnCount - 1 }
  switch (key) {
    case 'ArrowUp':
      return clampCell({ row: from.row - 1, column: from.column }, size)
    case 'ArrowDown':
      return clampCell({ row: from.row + 1, column: from.column }, size)
    case 'ArrowLeft':
      return clampCell({ row: from.row, column: from.column - 1 }, size)
    case 'ArrowRight':
      return clampCell({ row: from.row, column: from.column + 1 }, size)
    case 'PageUp':
      return clampCell({ row: from.row - page, column: from.column }, size)
    case 'PageDown':
      return clampCell({ row: from.row + page, column: from.column }, size)
    case 'Home':
      return clampCell({ row: ctrl ? 0 : from.row, column: 0 }, size)
    case 'End':
      return clampCell({ row: ctrl ? last.row : from.row, column: last.column }, size)
  }
}

export function moveSelection(
  selection: GridSelection | null,
  active: GridCell,
  key: GridKey,
  extend: boolean,
  options: MoveOptions,
): GridSelection {
  if (!extend) {
    return selectCell(movedCell(selection ? activeCell(selection) : active, key, options))
  }
  const base = selection ? asCells(selection, options.size) : selectCell(active)
  return { ...base, focus: movedCell(base.focus, key, options) }
}

export interface GridMetrics {
  origin: { x: number; y: number }
  scroll: { left: number; top: number }
  viewport: { width: number; height: number }
  labelWidth: number
  headerHeight: number
  rowHeight: number
  columnStarts: readonly number[]
  columnWidths: readonly number[]
}

function between(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high))
}

export function rangeRect(range: GridRange, metrics: GridMetrics): ViewerRect {
  const { origin, scroll, viewport, labelWidth, headerHeight, rowHeight } = metrics
  const bodyLeft = origin.x + labelWidth
  const bodyTop = origin.y + headerHeight
  const left = bodyLeft - scroll.left + (metrics.columnStarts[range.c1] ?? 0)
  const right =
    bodyLeft -
    scroll.left +
    (metrics.columnStarts[range.c2] ?? 0) +
    (metrics.columnWidths[range.c2] ?? 0)
  const top = bodyTop - scroll.top + range.r1 * rowHeight
  const bottom = bodyTop - scroll.top + (range.r2 + 1) * rowHeight
  const x1 = between(left, bodyLeft, origin.x + viewport.width)
  const x2 = between(right, bodyLeft, origin.x + viewport.width)
  const y1 = between(top, bodyTop, origin.y + viewport.height)
  const y2 = between(bottom, bodyTop, origin.y + viewport.height)
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}
