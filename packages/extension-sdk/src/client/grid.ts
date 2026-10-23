import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
} from '@tanstack/virtual-core'
import type { ViewerRect } from '../contract/viewerSelection'
import { columnStarts, columnWidths, revealOffset, rowLabelWidth } from './gridLayout'
import {
  activeCell,
  extendTo,
  GRID_KEYS,
  type GridCell,
  type GridKey,
  type GridRange,
  type GridSelection,
  type GridSize,
  moveSelection,
  rangeContains,
  rangeRect,
  selectAll,
  selectCell,
  selectHeader,
  selectionRange,
} from './gridSelection'
import { onSelectionCleared } from './viewer'

export { columnName } from './gridLayout'
export { type GridRange, rangeColumns, rangeLabel, rangeRows } from './gridSelection'

export interface GridOptions {
  label: string
  columns: string[]
  rowCount: number
  cell: (row: number, column: number) => string
  rowLabels?: boolean
  notes?: string[]
  describe?: (range: GridRange) => string
  onSelect?: (event: GridSelectEvent | null) => void
}

export interface GridSelectEvent {
  range: GridRange
  rect: ViewerRect
}

export interface Grid {
  element: HTMLElement
  selection: () => GridRange | null
  clearSelection: () => void
  setStatus: (text: string | null) => void
  destroy: () => void
}

const OVERSCAN = 8
const SCROLL_SETTLE_MS = 150
const HOST_CLEAR_SETTLE_MS = 500
const FALLBACK_CH = 8
const FALLBACK_ROW = 24

function div(className: string, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function measure(scroller: HTMLElement): { ch: number; row: number } {
  const probe = div('ostia-grid-cell ostia-grid-probe', '0000000000')
  scroller.append(probe)
  const ch = probe.offsetWidth / 10
  const row = probe.offsetHeight
  probe.remove()
  return { ch: ch > 0 ? ch : FALLBACK_CH, row: row > 0 ? row : FALLBACK_ROW }
}

function place(el: HTMLElement, left: number, top: number, width: number, height: number): void {
  el.style.transform = `translate(${left}px, ${top}px)`
  el.style.width = `${width}px`
  el.style.height = `${height}px`
}

export function grid(options: GridOptions): Grid {
  const root = div('ostia-grid')
  const notes = (options.notes ?? []).filter(Boolean)
  if (notes.length > 0) root.append(div('ostia-grid-note', notes.join(' ')))
  const status = div('ostia-grid-note')
  status.hidden = true
  status.setAttribute('role', 'status')
  const announcer = div('sr-only')
  announcer.setAttribute('role', 'status')
  const scroller = div('ostia-grid-scroll')
  scroller.setAttribute('role', 'grid')
  scroller.setAttribute('aria-label', options.label)
  scroller.setAttribute('aria-multiselectable', 'true')
  scroller.setAttribute('aria-rowcount', String(options.rowCount + 1))
  scroller.setAttribute('aria-colcount', String(options.columns.length))
  const canvas = div('ostia-grid-canvas')
  const header = div('ostia-grid-header')
  const corner = div('ostia-grid-corner')
  corner.dataset.part = 'corner'
  const body = div('ostia-grid-body')
  const labels = div('ostia-grid-labels')
  const cells = div('ostia-grid-cells')
  if (options.rowLabels) header.append(corner)
  body.append(labels, cells)
  canvas.append(header, body)
  scroller.append(canvas)
  root.append(status, scroller, announcer)

  const size: GridSize = { rowCount: options.rowCount, columnCount: options.columns.length }
  let unit = { ch: FALLBACK_CH, row: FALLBACK_ROW }
  let labelWidth = 0
  let widths: number[] = []
  let starts: number[] = []
  let selection: GridSelection | null = null
  let active: GridCell = { row: 0, column: 0 }
  let pressed = false
  let committedAt = Number.NEGATIVE_INFINITY
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  const rows = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: options.rowCount,
    getScrollElement: () => scroller,
    estimateSize: () => unit.row,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    overscan: OVERSCAN,
    onChange: () => render(),
  })
  const columns = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: options.columns.length,
    horizontal: true,
    getScrollElement: () => scroller,
    estimateSize: (index) => widths[index] ?? unit.ch * 6,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    overscan: 2,
    onChange: () => render(),
  })

  function layout(): void {
    unit = measure(scroller)
    widths = columnWidths(options.columns, options.rowCount, options.cell).map((w) => w * unit.ch)
    starts = columnStarts(widths)
    labelWidth = options.rowLabels ? rowLabelWidth(options.rowCount) * unit.ch : 0
    rows.setOptions({ ...rows.options, scrollMargin: unit.row })
    columns.setOptions({ ...columns.options, scrollMargin: labelWidth })
    rows.measure()
    columns.measure()
  }

  function currentRange(): GridRange | null {
    return selection ? selectionRange(selection, size) : null
  }

  function selectedClass(range: GridRange | null, row: number, column: number): string {
    if (!range || !rangeContains(range, row, column)) return ''
    const edges = [
      row === range.r1 ? ' ostia-grid-edge-top' : '',
      column === range.c2 ? ' ostia-grid-edge-right' : '',
      row === range.r2 ? ' ostia-grid-edge-bottom' : '',
      column === range.c1 ? ' ostia-grid-edge-left' : '',
    ].join('')
    return ` ostia-grid-selected${edges ? ` ostia-grid-edged${edges}` : ''}`
  }

  function cellElement(row: number, column: number): HTMLElement | null {
    return cells.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`)
  }

  function render(forceFocus = false): void {
    const hadFocus = forceFocus || root.contains(document.activeElement)
    const range = currentRange()
    const visibleRows = rows.getVirtualItems()
    const visibleColumns = columns.getVirtualItems()
    const width = labelWidth + columns.getTotalSize()
    const height = unit.row + rows.getTotalSize()
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    header.style.height = `${unit.row}px`
    body.style.height = `${rows.getTotalSize()}px`
    labels.style.width = `${labelWidth}px`
    corner.style.width = `${labelWidth}px`
    corner.style.height = `${unit.row}px`
    header.replaceChildren(...(options.rowLabels ? [corner] : []))
    labels.replaceChildren()
    const fragment = document.createDocumentFragment()
    for (const column of visibleColumns) {
      const inRange = range !== null && column.index >= range.c1 && column.index <= range.c2
      const title = div(
        `ostia-grid-cell ostia-grid-column${inRange ? ' ostia-grid-selected' : ''}`,
        options.columns[column.index],
      )
      title.setAttribute('role', 'columnheader')
      title.dataset.part = 'column'
      title.dataset.column = String(column.index)
      place(title, column.start, 0, column.size, unit.row)
      header.append(title)
    }
    for (const row of visibleRows) {
      const top = row.start - unit.row
      if (options.rowLabels) {
        const inRange = range !== null && row.index >= range.r1 && row.index <= range.r2
        const label = div(
          `ostia-grid-cell ostia-grid-label${inRange ? ' ostia-grid-selected' : ''}`,
          String(row.index + 1),
        )
        label.setAttribute('role', 'rowheader')
        label.dataset.part = 'row'
        label.dataset.row = String(row.index)
        place(label, 0, top, labelWidth, row.size)
        labels.append(label)
      }
      for (const column of visibleColumns) {
        const cell = div(
          `ostia-grid-cell${selectedClass(range, row.index, column.index)}`,
          options.cell(row.index, column.index),
        )
        cell.setAttribute('role', 'gridcell')
        cell.setAttribute('aria-rowindex', String(row.index + 2))
        cell.setAttribute('aria-colindex', String(column.index + 1))
        cell.setAttribute(
          'aria-selected',
          String(range !== null && rangeContains(range, row.index, column.index)),
        )
        cell.dataset.part = 'cell'
        cell.dataset.row = String(row.index)
        cell.dataset.column = String(column.index)
        cell.tabIndex = row.index === active.row && column.index === active.column ? 0 : -1
        place(cell, column.start, top, column.size, row.size)
        fragment.append(cell)
      }
    }
    cells.replaceChildren(fragment)
    const activeElement = cellElement(active.row, active.column)
    scroller.tabIndex = activeElement ? -1 : 0
    if (hadFocus) (activeElement ?? scroller).focus({ preventScroll: true })
  }

  function rectOf(range: GridRange): ViewerRect {
    const origin = scroller.getBoundingClientRect()
    return rangeRect(range, {
      origin: { x: origin.left, y: origin.top },
      scroll: { left: scroller.scrollLeft, top: scroller.scrollTop },
      viewport: { width: scroller.clientWidth, height: scroller.clientHeight },
      labelWidth,
      headerHeight: unit.row,
      rowHeight: unit.row,
      columnStarts: starts,
      columnWidths: widths,
    })
  }

  function announce(): void {
    const range = currentRange()
    announcer.textContent = range && options.describe ? options.describe(range) : ''
  }

  function commit(): void {
    committedAt = performance.now()
    announce()
    const range = currentRange()
    options.onSelect?.(range ? { range, rect: rectOf(range) } : null)
  }

  function reveal(cell: GridCell): void {
    scroller.scrollTop = revealOffset(
      cell.row * unit.row,
      unit.row,
      scroller.scrollTop,
      Math.max(0, scroller.clientHeight - unit.row),
    )
    scroller.scrollLeft = revealOffset(
      starts[cell.column] ?? 0,
      widths[cell.column] ?? 0,
      scroller.scrollLeft,
      Math.max(0, scroller.clientWidth - labelWidth),
    )
  }

  function select(next: GridSelection | null, scrollTo: { reveal: boolean }): void {
    selection = next
    if (next) active = activeCell(next)
    if (next && scrollTo.reveal) reveal(active)
    render(true)
    commit()
  }

  function cellAt(target: EventTarget | null): GridCell | null {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-part="cell"]') : null
    return el && scroller.contains(el)
      ? { row: Number(el.dataset.row), column: Number(el.dataset.column) }
      : null
  }

  function isEmpty(): boolean {
    return size.rowCount === 0 || size.columnCount === 0
  }

  function press(event: MouseEvent): void {
    if (event.button !== 0 || isEmpty()) return
    const target = event.target instanceof Element ? event.target : null
    const part = target?.closest<HTMLElement>('[data-part]')
    if (!part || !scroller.contains(part)) {
      if (
        event.target === scroller &&
        event.offsetX < scroller.clientWidth &&
        event.offsetY < scroller.clientHeight
      ) {
        select(null, { reveal: false })
      }
      return
    }
    event.preventDefault()
    pressed = true
    if (part.dataset.part === 'corner') selection = selectAll(size)
    else if (part.dataset.part === 'column') {
      selection = selectHeader(
        'columns',
        Number(part.dataset.column),
        event.shiftKey ? selection : null,
      )
    } else if (part.dataset.part === 'row') {
      selection = selectHeader('rows', Number(part.dataset.row), event.shiftKey ? selection : null)
    } else {
      const cell = { row: Number(part.dataset.row), column: Number(part.dataset.column) }
      selection = event.shiftKey ? extendTo(selection, active, cell) : selectCell(cell)
    }
    active = activeCell(selection)
    render(true)
  }

  function drag(event: MouseEvent): void {
    if (!pressed || !selection) return
    if ((event.buttons & 1) === 0) {
      release()
      return
    }
    const cell = cellAt(event.target)
    if (!cell || selection.shape !== 'cells') return
    if (cell.row === selection.focus.row && cell.column === selection.focus.column) return
    selection = { ...selection, focus: cell }
    active = cell
    render(true)
  }

  function release(): void {
    if (!pressed) return
    pressed = false
    commit()
  }

  function pressOutside(event: MouseEvent): void {
    if (selection && !event.composedPath().includes(root)) select(null, { reveal: false })
  }

  function pageRows(): number {
    return Math.max(1, Math.floor((scroller.clientHeight - unit.row) / unit.row))
  }

  const stopCleared = onSelectionCleared(() => {
    if (!selection || pressed || performance.now() - committedAt < HOST_CLEAR_SETTLE_MS) return
    select(null, { reveal: false })
  })
  scroller.addEventListener('mousedown', press)
  document.addEventListener('mousemove', drag)
  document.addEventListener('mouseup', release)
  document.addEventListener('mousedown', pressOutside)
  window.addEventListener('blur', release)
  scroller.addEventListener('copy', (event) => {
    if (selection) event.preventDefault()
  })
  scroller.addEventListener('scroll', () => {
    clearTimeout(settleTimer)
    if (selection) settleTimer = setTimeout(commit, SCROLL_SETTLE_MS)
  })
  scroller.addEventListener('keydown', (event) => {
    if (isEmpty() || event.altKey) return
    const modified = event.ctrlKey || event.metaKey
    if (modified && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      select(selectAll(size), { reveal: false })
    } else if (event.key === 'Escape') {
      if (!selection) return
      event.preventDefault()
      select(null, { reveal: false })
    } else if (event.key === ' ' && !modified) {
      event.preventDefault()
      select(selectCell(active), { reveal: true })
    } else if (
      GRID_KEYS.has(event.key) &&
      (!modified || event.key === 'Home' || event.key === 'End')
    ) {
      event.preventDefault()
      select(
        moveSelection(selection, active, event.key as GridKey, event.shiftKey, {
          size,
          page: pageRows(),
          ctrl: modified,
        }),
        { reveal: true },
      )
    }
  })

  const unmountRows = rows._didMount()
  const unmountColumns = columns._didMount()
  queueMicrotask(() => {
    layout()
    rows._willUpdate()
    columns._willUpdate()
    render()
  })
  return {
    element: root,
    selection: currentRange,
    clearSelection: () => {
      if (selection) select(null, { reveal: false })
    },
    setStatus: (text) => {
      status.hidden = text === null
      status.textContent = text ?? ''
    },
    destroy: () => {
      clearTimeout(settleTimer)
      stopCleared()
      document.removeEventListener('mousemove', drag)
      document.removeEventListener('mouseup', release)
      document.removeEventListener('mousedown', pressOutside)
      window.removeEventListener('blur', release)
      unmountRows()
      unmountColumns()
      root.remove()
    },
  }
}
