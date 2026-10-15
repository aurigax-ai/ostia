import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import type { PortableTable } from '@aurigax-ai/ostia-extension-sdk/contract/fileViewers'
import { type Grid, columnName, grid } from '@aurigax-ai/ostia-extension-sdk/grid'
import {
  ViewerDocumentError,
  openViewerDocument,
  publishPortable,
  runWorker,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { cellText } from './cellText'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import { OFFICE_LIMITS, type OfficeProblem } from './officeLimits'
import type { SheetData, Workbook, WorkbookResult } from './sheetModel'

const PORTABLE_ROWS = 5_000
const root = document.getElementById('root') as HTMLElement

type Translate = (key: string, vars?: Record<string, string | number>) => string

function show(...children: Node[]): void {
  root.replaceChildren(...children)
}

function message(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'message'
  el.textContent = text
  return el
}

function megabytes(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 1,
  }).format(bytes / 1e6)
}

function problemText(t: Translate, problem: OfficeProblem, locale: string): string {
  return t(problem, {
    limit: megabytes(
      problem === 'too-large' ? OFFICE_LIMITS.fileBytes : OFFICE_LIMITS.inflatedBytes,
      locale,
    ),
    cells: OFFICE_LIMITS.cells.toLocaleString(locale),
  })
}

function notesOf(t: Translate, book: Workbook, sheet: SheetData, locale: string): string[] {
  return [
    sheet.rowsCut ? t('rowsCut', { rows: sheet.rowCount.toLocaleString(locale) }) : '',
    sheet.columnsCut ? t('columnsCut', { columns: sheet.columnCount.toLocaleString(locale) }) : '',
    sheet.uncached > 0 ? t('uncached', { count: sheet.uncached }) : '',
    book.hidden > 0 ? t('hidden', { count: book.hidden }) : '',
    book.sheetsCut ? t('sheetsCut', { sheets: book.sheets.length }) : '',
    book.cellsCut ? t('cellsCut', { cells: OFFICE_LIMITS.cells.toLocaleString(locale) }) : '',
  ]
}

function portableOf(
  book: Workbook,
  text: (sheet: SheetData, row: number, column: number) => string,
) {
  const tables: PortableTable[] = book.sheets.map((sheet) => {
    const rows = Math.min(sheet.rowCount, PORTABLE_ROWS)
    const columns = Array.from({ length: sheet.columnCount }, (_u, c) => columnName(c))
    return {
      name: sheet.name,
      columns,
      rows: Array.from({ length: rows }, (_u, r) => columns.map((_name, c) => text(sheet, r, c))),
    }
  })
  return { tables }
}

function render(book: Workbook, t: Translate, locale: string): void {
  const words = { sheetTrue: t('true'), sheetFalse: t('false') }
  const text = (sheet: SheetData, row: number, column: number): string =>
    cellText(sheet.rows[row]?.[column], locale, words)
  let current: Grid | null = null
  const tabs = document.createElement('div')
  tabs.className = 'tabs'
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', t('sheets'))
  const select = (index: number): void => {
    const sheet = book.sheets[index]
    current?.destroy()
    for (const [i, tab] of Array.from(tabs.children).entries()) {
      tab.setAttribute('aria-selected', String(i === index))
    }
    if (sheet.columnCount === 0) {
      current = null
      show(message([t('empty'), ...notesOf(t, book, sheet, locale)].filter(Boolean).join(' ')))
    } else {
      current = grid({
        label: sheet.name,
        columns: Array.from({ length: sheet.columnCount }, (_u, c) => columnName(c)),
        rowCount: sheet.rowCount,
        cell: (row, column) => text(sheet, row, column),
        rowLabels: true,
        notes: notesOf(t, book, sheet, locale),
      })
      show(current.element)
    }
  }
  for (const [index, sheet] of book.sheets.entries()) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.setAttribute('role', 'tab')
    tab.textContent = sheet.name
    tab.addEventListener('click', () => select(index))
    tabs.append(tab)
  }
  if (book.sheets.length > 1) document.body.append(tabs)
  select(0)
  void publishPortable(portableOf(book, text))
}

async function main(): Promise<void> {
  const doc = await openViewerDocument().catch(() => null)
  const locale = doc?.locale ?? 'en'
  const t: Translate = translatorFor({ en: en.messages, 'zh-Hant': zhHant.messages }, locale)
  if (!doc) {
    show(message(t('unreadable')))
    return
  }
  doc.onDidChange(() => location.reload())
  show(message(t('loading')))
  let bytes: Uint8Array
  try {
    bytes = await doc.bytes()
  } catch (error) {
    const problem = error instanceof ViewerDocumentError ? error.problem : 'unreadable'
    show(message(problem === 'too-large' ? problemText(t, 'too-large', locale) : t(problem)))
    return
  }
  if (bytes.length > OFFICE_LIMITS.fileBytes) {
    show(message(problemText(t, 'too-large', locale)))
    return
  }
  const extension = doc.name.slice(doc.name.lastIndexOf('.') + 1).toLowerCase()
  const copy = bytes.slice()
  const outcome = await runWorker<WorkbookResult>(
    'sheet.worker.js',
    { bytes: copy.buffer, extension },
    [copy.buffer],
    OFFICE_LIMITS.parseMs,
  )
  if (!outcome.ok) {
    show(message(problemText(t, outcome.problem, locale)))
    return
  }
  if (!outcome.value.ok) {
    show(message(problemText(t, outcome.value.problem, locale)))
    return
  }
  if (outcome.value.book.sheets.length === 0) {
    show(message(t('empty')))
    return
  }
  render(outcome.value.book, t, locale)
}

void main()
