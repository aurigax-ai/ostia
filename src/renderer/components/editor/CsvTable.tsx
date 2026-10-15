import { fmt, useDict } from '@/lib/app/useDict'
import { CSV_COLUMNS_MAX, CSV_ROWS_MAX, type CsvTableData, parseCsv } from '@/lib/files/csvTable'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type MutableRefObject, useEffect, useState } from 'react'

export function CsvTable({
  source,
  delimiter,
  focusRef,
}: {
  source: string
  delimiter: string
  focusRef?: MutableRefObject<HTMLElement | null>
}): JSX.Element {
  const [table, setTable] = useState<CsvTableData | null>(null)

  useEffect(() => {
    let alive = true
    void parseCsv(source, delimiter).then((next) => {
      if (alive) setTable(next)
    })
    return () => {
      alive = false
    }
  }, [source, delimiter])

  if (!table) return <div className="csv-table" data-testid="csv-table" />
  return <CsvTableView table={table} focusRef={focusRef} />
}

export function CsvTableView({
  table,
  focusRef,
}: {
  table: CsvTableData
  focusRef?: MutableRefObject<HTMLElement | null>
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const setRoot = (el: HTMLDivElement | null): void => {
    if (focusRef) focusRef.current = el
  }
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the table scrolls with the keyboard
    <div ref={setRoot} className="csv-table" data-testid="csv-table" tabIndex={0}>
      {table.more || table.columnsCut ? (
        <p className="csv-table-note" data-testid="csv-table-note">
          {table.more
            ? fmt(d.viewer.csvRowsCut, { rows: CSV_ROWS_MAX.toLocaleString(locale) })
            : ''}
          {table.more && table.columnsCut ? ' ' : ''}
          {table.columnsCut ? fmt(d.viewer.csvColumnsCut, { columns: CSV_COLUMNS_MAX }) : ''}
        </p>
      ) : null}
      <table>
        <thead>
          <tr>
            {table.header.map((cell, column) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity but their position
              <th key={column} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, line) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their position
            <tr key={line}>
              {row.map((cell, column) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity but their position
                <td key={column}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
