import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import { grid } from '@aurigax-ai/ostia-extension-sdk/grid'
import { ViewerDocumentError, openViewerDocument } from '@aurigax-ai/ostia-extension-sdk/viewer'
import { COLUMNS_MAX, type CsvTable, delimiterOf } from './csvParse'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'

const PARSE_MS = 20_000

type Parsed = { ok: true; table: CsvTable } | { ok: false; problem: 'timeout' | 'failed' }

const root = document.getElementById('root') as HTMLElement

function message(text: string): void {
  const el = document.createElement('div')
  el.className = 'message'
  el.textContent = text
  root.replaceChildren(el)
}

function parse(bytes: Uint8Array, delimiter: string): Promise<Parsed> {
  return new Promise((resolve) => {
    const worker = new Worker('csv.worker.js')
    const finish = (result: Parsed): void => {
      clearTimeout(timer)
      worker.terminate()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, problem: 'timeout' }), PARSE_MS)
    worker.onmessage = (event: MessageEvent<{ ok: boolean; table?: CsvTable }>) =>
      finish(
        event.data.ok && event.data.table
          ? { ok: true, table: event.data.table }
          : { ok: false, problem: 'failed' },
      )
    worker.onerror = () => finish({ ok: false, problem: 'failed' })
    const copy = bytes.slice()
    worker.postMessage({ bytes: copy.buffer, delimiter }, [copy.buffer])
  })
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
  const parsed = await parse(bytes, delimiterOf(doc.name))
  if (!parsed.ok) {
    message(t(parsed.problem))
    return
  }
  const { table } = parsed
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
