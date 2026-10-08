import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

async function columns(win: Page) {
  return win.evaluate(() => {
    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement
    const listRect = list.getBoundingClientRect()
    const rows = [...document.querySelectorAll('[data-slot="palette-row"]')].map((row) => {
      const name = row.querySelector('[data-slot="palette-name"]') as HTMLElement
      const keys = row.querySelector('[data-slot="palette-keys"]') as HTMLElement
      const meta = row.querySelector('[data-slot="palette-meta"]') as HTMLElement
      const nameRect = name.getBoundingClientRect()
      return {
        nameRight: nameRect.left + name.scrollWidth,
        keysLeft: keys.getBoundingClientRect().left,
        hasKeys: keys.childElementCount > 0,
        metaRight: meta.getBoundingClientRect().right,
        sameLine: Math.abs(keys.getBoundingClientRect().top - nameRect.top) < 20,
      }
    })
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values)
    const widest = rows.reduce((a, b) => (b.nameRight > a.nameRight ? b : a))
    return {
      count: rows.length,
      keyed: rows.filter((r) => r.hasKeys).length,
      sameLine: rows.every((r) => r.sameLine),
      keysLeftSpread: spread(rows.map((r) => r.keysLeft)),
      metaRightSpread: spread(rows.map((r) => r.metaRight)),
      widestGap: widest.keysLeft - widest.nameRight,
      keysWithinHalf: rows.every((r) => r.keysLeft - listRect.left <= listRect.width * 0.7),
    }
  })
}

test('the palette lines keycaps up in one column right after the names and secondary text up at the right edge, with and without a query', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette.getByRole('option').first()).toBeVisible()

    const all = await columns(win)
    expect(all.count).toBeGreaterThan(1)
    expect(all.keyed).toBeGreaterThan(1)
    expect(all.sameLine).toBe(true)
    expect(all.keysLeftSpread).toBeLessThanOrEqual(1)
    expect(all.metaRightSpread).toBeLessThanOrEqual(1)
    expect(all.widestGap).toBeLessThanOrEqual(24)
    expect(all.keysWithinHalf).toBe(true)

    await palette.getByRole('combobox').fill('pane')
    await expect(palette.getByRole('option', { name: /pane/i }).first()).toBeVisible()
    const searched = await columns(win)
    expect(searched.count).toBeGreaterThan(1)
    expect(searched.keysLeftSpread).toBeLessThanOrEqual(1)
    expect(searched.metaRightSpread).toBeLessThanOrEqual(1)
    expect(searched.widestGap).toBeLessThanOrEqual(24)
  } finally {
    await app.close()
  }
})
