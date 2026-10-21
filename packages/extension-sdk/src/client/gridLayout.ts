const SAMPLE_ROWS = 200
const MIN_WIDTH = 3
const MAX_WIDTH = 48
const CELL_PADDING_CH = 2
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/g

export function textWidth(text: string): number {
  return text.length + (text.match(WIDE)?.length ?? 0)
}

export function columnWidths(
  columns: readonly string[],
  rowCount: number,
  cell: (row: number, column: number) => string,
): number[] {
  const sample = Math.min(rowCount, SAMPLE_ROWS)
  return columns.map((title, column) => {
    let width = textWidth(title)
    for (let row = 0; row < sample && width < MAX_WIDTH; row++) {
      width = Math.max(width, textWidth(cell(row, column)))
    }
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)) + CELL_PADDING_CH
  })
}

export function rowLabelWidth(rowCount: number): number {
  return Math.max(MIN_WIDTH, String(rowCount).length) + CELL_PADDING_CH
}

export function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}

export function columnStarts(widths: readonly number[]): number[] {
  const starts: number[] = []
  let at = 0
  for (const width of widths) {
    starts.push(at)
    at += width
  }
  return starts
}

export function revealOffset(start: number, size: number, offset: number, view: number): number {
  if (start < offset) return start
  if (start + size > offset + view) return Math.max(0, start + size - view)
  return offset
}
