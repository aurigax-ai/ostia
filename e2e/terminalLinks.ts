import { typeLineToEnd } from './helpers'
import { type Locator, type Page, expect } from './test'

export interface Point {
  x: number
  y: number
}

export async function linkPoint(win: Page, rowText: RegExp, needle: string): Promise<Point> {
  const row = win
    .locator('.pane-slot:not([data-hidden]) .xterm-rows')
    .first()
    .locator('div', { hasText: rowText })
    .first()
  await expect(row).toHaveCount(1, { timeout: 15_000 })
  const target = await row.evaluate((el, text) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(text) ?? -1
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + 1)
      const rect = range.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    return null
  }, needle)
  if (!target) throw new Error(`${needle} not found in the row`)
  return target
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

export async function hoverPoint(win: Page, point: Point): Promise<void> {
  await win.mouse.move(point.x, point.y + 80)
  await win.mouse.move(point.x, point.y, { steps: 6 })
}

export async function clickWith(win: Page, point: Point, keys: string[]): Promise<void> {
  await win.mouse.move(point.x, point.y)
  for (const key of keys) await win.keyboard.down(key)
  await win.mouse.click(point.x, point.y)
  for (const key of [...keys].reverse()) await win.keyboard.up(key)
}
