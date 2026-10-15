import { WINDOW_FROM_ROWS, columnWidths, rowLabelWidth } from '@/lib/files/gridColumns'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'

export interface GridSource {
  header: string[]
  rowCount: number
  cell: (row: number, column: number) => string
  rowLabels?: boolean
}

const ROW_ESTIMATE = 25
const OVERSCAN = 20
const CELL_PADDING = '21px'

function columnWidth(characters: number): string {
  return `calc(${characters}ch + ${CELL_PADDING})`
}

function GridRow({ source, row }: { source: GridSource; row: number }): JSX.Element {
  return (
    <tr>
      {source.rowLabels ? <th scope="row">{row + 1}</th> : null}
      {source.header.map((_title, column) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity but their position
        <td key={column}>{source.cell(row, column)}</td>
      ))}
    </tr>
  )
}

function AllRows({ source }: { source: GridSource }): JSX.Element {
  return (
    <tbody>
      {Array.from({ length: source.rowCount }, (_unused, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their position
        <GridRow key={row} source={source} row={row} />
      ))}
    </tbody>
  )
}

function WindowedRows({
  source,
  scrollElement,
  rowHeight,
}: {
  source: GridSource
  scrollElement: HTMLDivElement | null
  rowHeight: number
}): JSX.Element {
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  const virtualizer = useVirtualizer({
    count: source.rowCount,
    getScrollElement: () => scrollElement,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    scrollMargin: bodyRef.current?.offsetTop ?? 0,
  })
  const items = virtualizer.getVirtualItems()
  const margin = virtualizer.options.scrollMargin
  const before = items.length > 0 ? items[0].start - margin : 0
  const after =
    items.length > 0 ? virtualizer.getTotalSize() - (items[items.length - 1].end - margin) : 0
  return (
    <tbody ref={bodyRef}>
      {before > 0 ? (
        <tr aria-hidden className="csv-table-spacer" style={{ height: before }} />
      ) : null}
      {items.map((item) => (
        <GridRow key={item.index} source={source} row={item.index} />
      ))}
      {after > 0 ? <tr aria-hidden className="csv-table-spacer" style={{ height: after }} /> : null}
    </tbody>
  )
}

export function DataGrid({
  source,
  notes,
  windowed = true,
  testId,
}: {
  source: GridSource
  notes: string[]
  windowed?: boolean
  testId: string
}): JSX.Element {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const headRef = useRef<HTMLTableRowElement>(null)
  const [rowHeight, setRowHeight] = useState(ROW_ESTIMATE)
  useLayoutEffect(() => {
    const measured = headRef.current?.offsetHeight ?? 0
    if (measured > 0) setRowHeight(measured)
  }, [])
  const widths = useMemo(() => columnWidths(source.header, source.rowCount, source.cell), [source])
  const rows =
    windowed && source.rowCount > WINDOW_FROM_ROWS ? (
      <WindowedRows
        key={rowHeight}
        source={source}
        scrollElement={scrollElement}
        rowHeight={rowHeight}
      />
    ) : (
      <AllRows source={source} />
    )
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the table scrolls with the keyboard
    <div ref={setScrollElement} className="csv-table" data-testid={testId} tabIndex={0}>
      {notes.length > 0 ? (
        <p className="csv-table-note" data-testid={`${testId}-note`}>
          {notes.join(' ')}
        </p>
      ) : null}
      <table>
        <colgroup>
          {source.rowLabels ? (
            <col style={{ width: columnWidth(rowLabelWidth(source.rowCount)) }} />
          ) : null}
          {widths.map((width, column) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity but their position
            <col key={column} style={{ width: columnWidth(width) }} />
          ))}
        </colgroup>
        <thead>
          <tr ref={headRef}>
            {source.rowLabels ? <td className="csv-table-corner" /> : null}
            {source.header.map((title, column) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity but their position
              <th key={column} scope="col">
                {title}
              </th>
            ))}
          </tr>
        </thead>
        {rows}
      </table>
    </div>
  )
}
