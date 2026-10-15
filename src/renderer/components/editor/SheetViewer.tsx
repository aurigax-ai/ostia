import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatBytes } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { extension } from '@/lib/files/fileKinds'
import { type FileBytes, useFileBytes } from '@/lib/files/viewerHooks'
import { cellText, columnName } from '@/lib/office/cellText'
import { OFFICE_LIMITS, type OfficeProblem } from '@/lib/office/officeLimits'
import type { SheetData, Workbook, WorkbookResult } from '@/lib/office/sheetModel'
import { parseWorkbook } from '@/lib/office/workbookClient'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { Dict } from '@shared/app/dict'
import { useEffect, useMemo, useState } from 'react'
import { DataGrid, type GridSource } from './DataGrid'
import { ViewerMessage, useBytesProblem } from './ViewerChrome'

function useWorkbook(bytes: FileBytes, fileExtension: string): WorkbookResult | null {
  const [result, setResult] = useState<WorkbookResult | null>(null)
  useEffect(() => {
    setResult(null)
    if ('status' in bytes || !bytes.ok) return
    let alive = true
    const parse = parseWorkbook(bytes.data, fileExtension)
    void parse.result.then((next) => {
      if (alive) setResult(next)
    })
    return () => {
      alive = false
      parse.cancel()
    }
  }, [bytes, fileExtension])
  return result
}

function problemText(d: Dict, problem: OfficeProblem, locale: string): string {
  switch (problem) {
    case 'too-large':
      return fmt(d.viewer.officeTooLarge, { limit: formatBytes(OFFICE_LIMITS.fileBytes, locale) })
    case 'unzip-limit':
      return fmt(d.viewer.officeUnzipLimit, {
        limit: formatBytes(OFFICE_LIMITS.inflatedBytes, locale),
      })
    case 'timeout':
      return d.viewer.officeTimeout
    case 'encrypted':
      return d.viewer.officeEncrypted
    default:
      return d.viewer.officeFailed
  }
}

function sheetNotes(d: Dict, book: Workbook, sheet: SheetData, locale: string): string[] {
  return [
    sheet.rowsCut ? fmt(d.viewer.csvRowsCut, { rows: sheet.rowCount.toLocaleString(locale) }) : '',
    sheet.columnsCut ? fmt(d.viewer.csvColumnsCut, { columns: sheet.columnCount }) : '',
    sheet.uncached > 0 ? fmt(d.viewer.sheetUncached, { count: sheet.uncached }) : '',
    book.hidden > 0 ? fmt(d.viewer.sheetHidden, { count: book.hidden }) : '',
    book.sheetsCut ? fmt(d.viewer.sheetsCut, { sheets: book.sheets.length }) : '',
    book.cellsCut
      ? fmt(d.viewer.sheetCellsCut, { cells: OFFICE_LIMITS.cells.toLocaleString(locale) })
      : '',
  ].filter(Boolean)
}

function SheetGrid({ book, sheet }: { book: Workbook; sheet: SheetData }): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const source = useMemo<GridSource>(
    () => ({
      header: Array.from({ length: sheet.columnCount }, (_unused, column) => columnName(column)),
      rowCount: sheet.rowCount,
      cell: (row, column) => cellText(sheet.rows[row]?.[column], locale, d.viewer),
      rowLabels: true,
    }),
    [sheet, locale, d],
  )
  const notes = sheetNotes(d, book, sheet, locale)
  if (sheet.columnCount === 0) {
    return <ViewerMessage>{[d.viewer.sheetEmpty, ...notes].join(' ')}</ViewerMessage>
  }
  return <DataGrid source={source} notes={notes} testId="sheet-grid" />
}

export function SheetViewer({ filePath }: { filePath: string }): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const bytes = useFileBytes(filePath)
  const bytesProblem = useBytesProblem(bytes)
  const parsed = useWorkbook(bytes, extension(filePath))
  const [active, setActive] = useState(0)

  const book = parsed?.ok ? parsed.book : null
  const sheet = book?.sheets[Math.min(active, book.sheets.length - 1)]
  const message =
    bytesProblem ??
    (!parsed
      ? d.viewer.loading
      : !parsed.ok
        ? problemText(d, parsed.problem, locale)
        : sheet
          ? null
          : d.viewer.sheetEmpty)

  return (
    <div className="viewer-surface" data-testid="sheet-viewer">
      <div className="viewer-toolbar">
        <span className="viewer-title">{filePath.split('/').pop()}</span>
        {sheet ? (
          <span className="viewer-meta">
            {sheet.rowCount.toLocaleString(locale)} × {sheet.columnCount.toLocaleString(locale)}
          </span>
        ) : null}
      </div>
      <div className="sheet-body">
        {message || !book || !sheet ? (
          <ViewerMessage>{message}</ViewerMessage>
        ) : (
          <SheetGrid key={sheet.name} book={book} sheet={sheet} />
        )}
      </div>
      {book && book.sheets.length > 1 ? (
        <Tabs
          className="sheet-tabs"
          value={Math.min(active, book.sheets.length - 1)}
          onValueChange={(value) => setActive(Number(value))}
        >
          <TabsList variant="line" aria-label={d.viewer.sheets}>
            {book.sheets.map((entry, index) => (
              <TabsTrigger key={entry.name} value={index} className="text-ui-sm font-normal">
                {entry.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}
    </div>
  )
}
