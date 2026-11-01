import { typeLineToEnd } from './helpers'
import { expect, type Locator, type Page } from './test'

export interface Point {
  x: number
  y: number
}

export async function linkPoint(win: Page, rowText: RegExp, needle: string): Promise<Point> {
  const slot = win.locator('.workzone-workspace:not([data-hidden]) .pane-slot:not([data-hidden])')
  const region = slot.locator('.terminal-text').first()
  const row = region.locator('div', { hasText: rowText }).first()
  await expect(row).toHaveCount(1, { timeout: 15_000 })
  const located = await region.evaluate(
    (el, { source, flags, text }) => {
      const pattern = new RegExp(source, flags)
      const rows = [...el.children].map((child) => child.textContent ?? '')
      const index = rows.findIndex((line) => pattern.test(line))
      return {
        index,
        col: index < 0 ? -1 : rows[index].indexOf(text),
        cols: Number(el.dataset.cols),
        rowCount: Number(el.dataset.rows),
      }
    },
    { source: rowText.source, flags: rowText.flags, text: needle },
  )
  if (located.index < 0 || located.col < 0) throw new Error(`${needle} not found in the row`)
  const screen = slot.locator('.ghostty-screen').first()
  return cellPoint(
    screen,
    { rows: located.rowCount, cols: located.cols },
    located.col,
    located.index,
  )
}

export async function printOnFirstRow(win: Page, screen: Locator, text: string): Promise<Point> {
  const before = await screen.boundingBox()
  if (!before) throw new Error('terminal screen not found')
  await win.mouse.click(before.x + before.width / 2, before.y + before.height - 8)
  await typeLineToEnd(win, `clear; printf '%s\\n' '${text}'`)
  const box = await screen.boundingBox()
  if (!box) throw new Error('terminal screen not found')
  return { x: box.x + 30, y: box.y + 8 }
}

export interface CellGrid {
  rows: number
  cols: number
}

export async function cellPoint(
  screen: Locator,
  grid: CellGrid,
  col: number,
  row: number,
): Promise<Point> {
  const box = await screen.boundingBox()
  if (!box) throw new Error('terminal screen not found')
  return {
    x: box.x + ((col + 0.5) * box.width) / grid.cols,
    y: box.y + ((row + 0.5) * box.height) / grid.rows,
  }
}

export async function hoverPoint(win: Page, point: Point): Promise<void> {
  await win.mouse.move(point.x, point.y + 80)
  await win.mouse.move(point.x, point.y, { steps: 6 })
  await win.mouse.move(point.x + 1, point.y)
  await win.mouse.move(point.x, point.y)
}

export async function clickWith(win: Page, point: Point, keys: string[]): Promise<void> {
  await win.mouse.move(point.x, point.y)
  for (const key of keys) await win.keyboard.down(key)
  await win.mouse.click(point.x, point.y)
  for (const key of [...keys].reverse()) await win.keyboard.up(key)
}
