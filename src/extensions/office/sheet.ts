import { type CellsPublisher, createCellsPublisher } from '@aurigax-ai/ostia-extension-sdk/cells'
import type { Translate } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import {
  PORTABLE_TABLE_ROWS_MAX,
  type PortableTable,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import {
  columnName,
  type Grid,
  grid,
  rangeColumns,
  rangeLabel,
  rangeRows,
} from '@aurigax-ai/ostia-extension-sdk/grid'
import {
  publishPortable,
  runWorker,
  showViewerMessage,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import { cellText } from './cellText'
import { OFFICE_LIMITS, officeProblemText } from './officeLimits'
import { loadOfficeBytes } from './officePage'
import type { SheetData, Workbook, WorkbookResult } from './sheetModel'

const root = document.getElementById('root') as HTMLElement

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
    const rows = Math.min(sheet.rowCount, PORTABLE_TABLE_ROWS_MAX)
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
  let publisher: CellsPublisher | null = null
  const tabs = document.createElement('div')
  tabs.className = 'tabs'
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', t('sheets'))
  const select = (index: number): void => {
    const sheet = book.sheets[index]
    publisher?.clear()
    current?.destroy()
    for (const [i, tab] of Array.from(tabs.children).entries()) {
      tab.setAttribute('aria-selected', String(i === index))
    }
    if (sheet.columnCount === 0) {
      current = null
      publisher = null
      showViewerMessage(
        root,
        [t('empty'), ...notesOf(t, book, sheet, locale)].filter(Boolean).join(' '),
      )
    } else {
      const view = grid({
        label: sheet.name,
        columns: Array.from({ length: sheet.columnCount }, (_u, c) => columnName(c)),
        rowCount: sheet.rowCount,
        cell: (row, column) => text(sheet, row, column),
        rowLabels: true,
        notes: notesOf(t, book, sheet, locale),
        describe: (range) =>
          t('selected', {
            range: rangeLabel(range),
            rows: rangeRows(range).toLocaleString(locale),
            columns: rangeColumns(range).toLocaleString(locale),
          }),
        onSelect: (event) => publisher?.update(event),
      })
      publisher = createCellsPublisher(
        { sheet: sheet.name, rowOffset: 0, text: (row, column) => text(sheet, row, column) },
        (tooLarge) => view.setStatus(tooLarge ? t('selectionTooLarge') : null),
      )
      current = view
      root.replaceChildren(view.element)
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
  const loaded = await loadOfficeBytes(root)
  if (!loaded) return
  const { doc, t, bytes } = loaded
  const say = (text: string): void => {
    showViewerMessage(root, text)
  }
  const outcome = await runWorker<WorkbookResult>(
    'sheet.worker.js',
    { bytes },
    [bytes],
    OFFICE_LIMITS.parseMs,
  )
  if (!outcome.ok) {
    say(officeProblemText(t, outcome.problem, doc.locale))
    return
  }
  if (!outcome.value.ok) {
    say(officeProblemText(t, outcome.value.problem, doc.locale))
    return
  }
  if (outcome.value.book.sheets.length === 0) {
    say(t('empty'))
    return
  }
  render(outcome.value.book, t, doc.locale)
}

void main()
