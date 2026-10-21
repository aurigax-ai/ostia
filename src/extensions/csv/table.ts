import { createCellsPublisher } from '@aurigax-ai/ostia-extension-sdk/cells'
import { PORTABLE_TABLE_ROWS_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { grid, rangeColumns, rangeLabel, rangeRows } from '@aurigax-ai/ostia-extension-sdk/grid'
import {
  loadViewerBytes,
  publishPortable,
  runWorker,
  showViewerMessage,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { CSV_LIMITS, type CsvTable, delimiterOf } from './csvShape'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'

const PARSE_MS = 20_000
const HEADER_ROWS = 1

const root = document.getElementById('root') as HTMLElement

async function main(): Promise<void> {
  const loaded = await loadViewerBytes({
    root,
    catalogs: { en: en.messages, 'zh-Hant': zhHant.messages },
  })
  if (!loaded) return
  const { doc, t, bytes } = loaded
  const parsed = await runWorker<{ ok: boolean; table?: CsvTable }>(
    'csv.worker.js',
    { bytes, delimiter: delimiterOf(doc.name) },
    [bytes],
    PARSE_MS,
  )
  if (!parsed.ok || !parsed.value.ok || !parsed.value.table) {
    showViewerMessage(root, t(parsed.ok ? 'failed' : parsed.problem))
    return
  }
  const { table } = parsed.value
  if (table.header.length === 0) {
    showViewerMessage(root, t('empty'))
    return
  }
  const notes = [
    table.rowsCut ? t('rowsCut', { rows: table.rows.length.toLocaleString(doc.locale) }) : '',
    table.columnsCut
      ? t('columnsCut', { columns: CSV_LIMITS.columns.toLocaleString(doc.locale) })
      : '',
  ]
  const cell = (row: number, column: number): string => table.rows[row]?.[column] ?? ''
  const publisher = createCellsPublisher(
    { sheet: '', rowOffset: HEADER_ROWS, text: cell },
    (tooLarge) => view.setStatus(tooLarge ? t('selectionTooLarge') : null),
  )
  const view = grid({
    label: doc.name,
    columns: table.header,
    rowCount: table.rows.length,
    cell,
    notes,
    describe: (range) =>
      t('selected', {
        range: rangeLabel(range, HEADER_ROWS),
        rows: rangeRows(range).toLocaleString(doc.locale),
        columns: rangeColumns(range).toLocaleString(doc.locale),
      }),
    onSelect: publisher.update,
  })
  root.replaceChildren(view.element)
  void publishPortable({
    tables: [
      {
        name: doc.name,
        columns: table.header,
        rows: table.rows.slice(0, PORTABLE_TABLE_ROWS_MAX),
      },
    ],
  })
}

void main()
