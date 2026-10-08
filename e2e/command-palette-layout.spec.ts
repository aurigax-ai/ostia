import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

async function gaps(win: Page) {
  return win.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-slot="command-item"]')]
    const measured = rows.flatMap((row) => {
      const title = row.querySelector('[data-slot="palette-row"] > :first-child')
      const next = title?.nextElementSibling
      if (!title || !next) return []
      return [
        {
          gap: next.getBoundingClientRect().left - title.getBoundingClientRect().right,
          sameLine:
            Math.abs(next.getBoundingClientRect().top - title.getBoundingClientRect().top) < 20,
          rowRight: row.getBoundingClientRect().right,
          nextRight: next.getBoundingClientRect().right,
        },
      ]
    })
    return {
      count: measured.length,
      sameLine: measured.every((m) => m.sameLine),
      gapSpread: Math.max(...measured.map((m) => m.gap)) - Math.min(...measured.map((m) => m.gap)),
      pushedRight: measured.some((m) => m.rowRight - m.nextRight < 4 && m.gap > 200),
    }
  })
}

test('the palette puts each row’s secondary text right after its title, with and without a query', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette.getByRole('option').first()).toBeVisible()

    const all = await gaps(win)
    expect(all.count).toBeGreaterThan(1)
    expect(all.sameLine).toBe(true)
    expect(all.gapSpread).toBeLessThanOrEqual(1)
    expect(all.pushedRight).toBe(false)

    await palette.getByRole('combobox').fill('pane')
    await expect(palette.getByRole('option', { name: /pane/i }).first()).toBeVisible()
    const searched = await gaps(win)
    expect(searched.count).toBeGreaterThan(1)
    expect(searched.sameLine).toBe(true)
    expect(searched.gapSpread).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
  }
})
