import { VIEWER_CELLS_MAX, VIEWER_CSV_MAX } from '../contract/viewerSelection'
import type { GridSelectEvent } from './grid'
import { type GridRange, rangeColumns, rangeLabel, rangeRows } from './gridSelection'
import { clearSelection, publishSelection } from './viewer'

const PUBLISH_DELAY_MS = 80
const NEEDS_QUOTES = /[",\r\n]/

export interface CellsSource {
  sheet: string
  rowOffset: number
  text: (row: number, column: number) => string
}

export interface CellsPayload {
  sheet: string
  range: string
  rows: number
  columns: number
  csv: string
}

export type CellsOutcome =
  | { kind: 'ready'; payload: CellsPayload }
  | { kind: 'too-large' }
  | { kind: 'empty' }

export function csvField(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function cellsOutcome(source: CellsSource, range: GridRange): CellsOutcome {
  const rows = rangeRows(range)
  const columns = rangeColumns(range)
  if (rows * columns > VIEWER_CELLS_MAX) return { kind: 'too-large' }
  const lines: string[] = []
  for (let row = range.r1; row <= range.r2; row++) {
    const fields: string[] = []
    for (let column = range.c1; column <= range.c2; column++) {
      fields.push(csvField(source.text(row, column)))
    }
    lines.push(fields.join(','))
  }
  const csv = lines.join('\n')
  if (new TextEncoder().encode(csv).byteLength > VIEWER_CSV_MAX) return { kind: 'too-large' }
  if (csv === '') return { kind: 'empty' }
  const { sheet, rowOffset } = source
  return {
    kind: 'ready',
    payload: { sheet, range: rangeLabel(range, rowOffset), rows, columns, csv },
  }
}

export interface CellsPublisher {
  update: (event: GridSelectEvent | null) => void
  clear: () => void
}

export function createCellsPublisher(
  source: CellsSource,
  setTooLarge: (tooLarge: boolean) => void,
): CellsPublisher {
  let timer: ReturnType<typeof setTimeout> | undefined
  let published: string | null = null
  let queue: Promise<unknown> = Promise.resolve()

  const enqueue = (task: () => Promise<unknown>): void => {
    queue = queue.then(task, task)
  }

  const withdraw = (): void => {
    if (published === null) return
    published = null
    enqueue(clearSelection)
  }

  const flush = (event: GridSelectEvent | null): void => {
    if (!event) {
      setTooLarge(false)
      withdraw()
      return
    }
    const outcome = cellsOutcome(source, event.range)
    setTooLarge(outcome.kind === 'too-large')
    if (outcome.kind !== 'ready') {
      withdraw()
      return
    }
    const { csv, ...capture } = outcome.payload
    const key = JSON.stringify([capture, csv, event.rect])
    if (key === published) return
    published = key
    enqueue(() =>
      publishSelection({ capture: { kind: 'cells', ...capture }, csv, rect: event.rect }),
    )
  }

  const clear = (): void => {
    clearTimeout(timer)
    flush(null)
  }

  return {
    update: (event) => {
      if (!event) {
        clear()
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => flush(event), PUBLISH_DELAY_MS)
    },
    clear,
  }
}
