import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

async function rightEdgeSpread(win: Page) {
  return win.evaluate(() => {
    const spread = (selector: string) => {
      const edges = [...document.querySelectorAll(selector)].map(
        (el) => el.getBoundingClientRect().right,
      )
      return { count: edges.length, spread: Math.max(...edges) - Math.min(...edges) }
    }
    return {
      meta: spread('[data-slot="command-item"] [data-slot="palette-meta"]'),
      keys: spread('[data-slot="command-item"] kbd'),
    }
  })
}

test('the palette lines up the right-hand values of its rows, with and without a query', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette.getByRole('option').first()).toBeVisible()

    const all = await rightEdgeSpread(win)
    expect(all.keys.count).toBeGreaterThan(1)
    expect(all.meta.count).toBeGreaterThan(1)
    expect(all.meta.spread).toBeLessThanOrEqual(1)
    expect(all.keys.spread).toBeLessThanOrEqual(1)

    await palette.getByRole('combobox').fill('pane')
    await expect(palette.getByRole('option', { name: /pane/i }).first()).toBeVisible()
    const searched = await rightEdgeSpread(win)
    expect(searched.keys.count).toBeGreaterThan(1)
    expect(searched.meta.spread).toBeLessThanOrEqual(1)
    expect(searched.keys.spread).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
  }
})
