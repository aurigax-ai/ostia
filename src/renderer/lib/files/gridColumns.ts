const SAMPLE_ROWS = 200
const MIN_WIDTH = 3
const MAX_WIDTH = 48
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/g

export const WINDOW_FROM_ROWS = 200

function textWidth(text: string): number {
  return text.length + (text.match(WIDE)?.length ?? 0)
}

export function columnWidths(
  header: string[],
  rowCount: number,
  cell: (row: number, column: number) => string,
): number[] {
  const sample = Math.min(rowCount, SAMPLE_ROWS)
  return header.map((title, column) => {
    let width = textWidth(title)
    for (let row = 0; row < sample && width < MAX_WIDTH; row++) {
      width = Math.max(width, textWidth(cell(row, column)))
    }
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))
  })
}

export function rowLabelWidth(rowCount: number): number {
  return Math.max(MIN_WIDTH, String(rowCount).length)
}
