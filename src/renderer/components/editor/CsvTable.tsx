import { fmt, useDict } from '@/lib/app/useDict'
import { CSV_COLUMNS_MAX, type CsvTableData, parseCsv } from '@/lib/files/csvTable'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useEffect, useMemo, useState } from 'react'
import { DataGrid, type GridSource } from './DataGrid'

export function CsvTable({
  source,
  delimiter,
}: { source: string; delimiter: string }): JSX.Element {
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
  return <CsvTableView table={table} />
}

export function CsvTableView({
  table,
  windowed = true,
}: { table: CsvTableData; windowed?: boolean }): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const source = useMemo<GridSource>(
    () => ({
      header: table.header,
      rowCount: table.rows.length,
      cell: (row, column) => table.rows[row][column],
    }),
    [table],
  )
  const notes = [
    table.more ? fmt(d.viewer.csvRowsCut, { rows: table.rows.length.toLocaleString(locale) }) : '',
    table.columnsCut ? fmt(d.viewer.csvColumnsCut, { columns: CSV_COLUMNS_MAX }) : '',
  ].filter(Boolean)
  return <DataGrid source={source} notes={notes} windowed={windowed} testId="csv-table" />
}
