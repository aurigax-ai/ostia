import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
} from '@tanstack/virtual-core'
import { columnWidths, rowLabelWidth } from './gridLayout'

export { columnName } from './gridLayout'

export interface GridOptions {
  label: string
  columns: string[]
  rowCount: number
  cell: (row: number, column: number) => string
  rowLabels?: boolean
  notes?: string[]
}

export interface Grid {
  element: HTMLElement
  destroy: () => void
}

const OVERSCAN = 8
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
  const scroller = div('ostia-grid-scroll')
  scroller.tabIndex = 0
  scroller.setAttribute('role', 'grid')
  scroller.setAttribute('aria-label', options.label)
  scroller.setAttribute('aria-rowcount', String(options.rowCount + 1))
  scroller.setAttribute('aria-colcount', String(options.columns.length))
  const canvas = div('ostia-grid-canvas')
  const header = div('ostia-grid-header')
  const corner = div('ostia-grid-corner')
  const body = div('ostia-grid-body')
  const labels = div('ostia-grid-labels')
  const cells = div('ostia-grid-cells')
  if (options.rowLabels) header.append(corner)
  body.append(labels, cells)
  canvas.append(header, body)
  scroller.append(canvas)
  root.append(scroller)

  let unit = { ch: FALLBACK_CH, row: FALLBACK_ROW }
  let labelWidth = 0
  let widths: number[] = []
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
    labelWidth = options.rowLabels ? rowLabelWidth(options.rowCount) * unit.ch : 0
    rows.setOptions({ ...rows.options, scrollMargin: unit.row })
    columns.setOptions({ ...columns.options, scrollMargin: labelWidth })
    rows.measure()
    columns.measure()
  }

  function render(): void {
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
      const title = div('ostia-grid-cell ostia-grid-column', options.columns[column.index])
      title.setAttribute('role', 'columnheader')
      place(title, column.start, 0, column.size, unit.row)
      header.append(title)
    }
    for (const row of visibleRows) {
      const top = row.start - unit.row
      if (options.rowLabels) {
        const label = div('ostia-grid-cell ostia-grid-label', String(row.index + 1))
        label.setAttribute('role', 'rowheader')
        place(label, 0, top, labelWidth, row.size)
        labels.append(label)
      }
      for (const column of visibleColumns) {
        const cell = div('ostia-grid-cell', options.cell(row.index, column.index))
        cell.setAttribute('role', 'gridcell')
        place(cell, column.start, top, column.size, row.size)
        fragment.append(cell)
      }
    }
    cells.replaceChildren(fragment)
  }

  const keys: Record<string, (el: HTMLElement) => void> = {
    ArrowDown: (el) => el.scrollBy({ top: unit.row }),
    ArrowUp: (el) => el.scrollBy({ top: -unit.row }),
    ArrowRight: (el) => el.scrollBy({ left: unit.ch * 8 }),
    ArrowLeft: (el) => el.scrollBy({ left: -unit.ch * 8 }),
    PageDown: (el) => el.scrollBy({ top: el.clientHeight - unit.row }),
    PageUp: (el) => el.scrollBy({ top: -(el.clientHeight - unit.row) }),
    Home: (el) => el.scrollTo({ top: 0, left: 0 }),
    End: (el) => el.scrollTo({ top: el.scrollHeight }),
  }
  scroller.addEventListener('keydown', (event) => {
    const move = keys[event.key]
    if (!move) return
    event.preventDefault()
    move(scroller)
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
    destroy: () => {
      unmountRows()
      unmountColumns()
      root.remove()
    },
  }
}
