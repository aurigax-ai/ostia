import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { grid } from '@aurigax-ai/ostia-extension-sdk/grid'
import {
  ViewerDocumentError,
  openViewerDocument,
  runWorker,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { COLUMNS_MAX, type CsvTable, delimiterOf } from './csvShape'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'

const PARSE_MS = 20_000

const root = document.getElementById('root') as HTMLElement

function message(text: string): void {
  const el = document.createElement('div')
  el.className = 'message'
  el.textContent = text
  root.replaceChildren(el)
}

async function main(): Promise<void> {
  const doc = await openViewerDocument().catch(() => null)
  const t = translatorFor({ en: en.messages, 'zh-Hant': zhHant.messages }, doc?.locale ?? 'en')
  if (!doc) {
    message(t('unreadable'))
    return
  }
  doc.onDidChange(() => location.reload())
  message(t('loading'))
  let bytes: Uint8Array
  try {
    bytes = await doc.bytes()
  } catch (error) {
    const problem = error instanceof ViewerDocumentError ? error.problem : 'unreadable'
    const size = new Intl.NumberFormat(doc.locale, {
      style: 'unit',
      unit: 'megabyte',
      maximumFractionDigits: 1,
    }).format((error instanceof ViewerDocumentError ? (error.size ?? 0) : 0) / 1e6)
    message(problem === 'too-large' ? t('tooLarge', { size }) : t(problem))
    return
  }
  const copy = bytes.slice()
  const parsed = await runWorker<{ ok: boolean; table?: CsvTable }>(
    'csv.worker.js',
    { bytes: copy.buffer, delimiter: delimiterOf(doc.name) },
    [copy.buffer],
    PARSE_MS,
  )
  if (!parsed.ok || !parsed.value.ok || !parsed.value.table) {
    message(t(parsed.ok ? 'failed' : parsed.problem))
    return
  }
  const { table } = parsed.value
  if (table.header.length === 0) {
    message(t('empty'))
    return
  }
  const notes = [
    table.rowsCut ? t('rowsCut', { rows: table.rows.length.toLocaleString(doc.locale) }) : '',
    table.columnsCut ? t('columnsCut', { columns: COLUMNS_MAX.toLocaleString(doc.locale) }) : '',
  ]
  const view = grid({
    label: doc.name,
    columns: table.header,
    rowCount: table.rows.length,
    cell: (row, column) => table.rows[row]?.[column] ?? '',
    notes,
  })
  root.replaceChildren(view.element)
}

void main()
