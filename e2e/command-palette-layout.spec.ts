import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

async function rowLayout(win: Page) {
  return win.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-slot="palette-row"]')].map((row) => {
      const box = row.getBoundingClientRect()
      const cells = [...row.children].map((cell) => cell.getBoundingClientRect())
      return {
        titleInset: cells[0].left - box.left,
        gaps: cells.slice(1).map((cell, i) => cell.left - cells[i].right),
        overflow: Math.max(...cells.map((cell) => cell.right)) - box.right,
      }
    })
    const gaps = rows.flatMap((row) => row.gaps)
    return {
      keys: document.querySelectorAll('[data-slot="palette-row"] > kbd').length,
      meta: document.querySelectorAll('[data-slot="palette-row"] > [data-slot="palette-meta"]')
        .length,
      titleInset: Math.max(...rows.map((row) => Math.abs(row.titleInset))),
      gapMin: Math.min(...gaps),
      gapMax: Math.max(...gaps),
      overflow: Math.max(...rows.map((row) => row.overflow)),
    }
  })
}

async function squeezeFirstRow(win: Page) {
  return win.evaluate(() => {
    const meta = document.querySelector<HTMLElement>('[data-slot="palette-meta"]')
    const row = meta?.closest<HTMLElement>('[data-slot="palette-row"]')
    const title = row?.querySelector<HTMLElement>('[data-slot="palette-title"]')
    const item = row?.closest<HTMLElement>('[data-slot="command-item"]')
    if (!meta || !row || !title || !item) return null
    const width = item.style.width
    item.style.width = `${title.getBoundingClientRect().width + 80}px`
    const squeezed = {
      titleCut: title.scrollWidth > title.clientWidth,
      metaCut: meta.scrollWidth > meta.clientWidth,
      metaOverflow: getComputedStyle(meta).textOverflow,
      metaInside: meta.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5,
    }
    item.style.width = width
    return squeezed
  })
}

function expectSecondaryAfterTitle(layout: Awaited<ReturnType<typeof rowLayout>>): void {
  expect(layout.keys).toBeGreaterThan(1)
  expect(layout.titleInset).toBeLessThanOrEqual(0.5)
  expect(layout.gapMin).toBeGreaterThan(0)
  expect(layout.gapMax - layout.gapMin).toBeLessThanOrEqual(0.5)
  expect(layout.overflow).toBeLessThanOrEqual(0.5)
}

test('the palette puts each row’s keys and path right after its title with one gap, and cuts the path before the title', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette.getByRole('option').first()).toBeVisible()

    const all = await rowLayout(win)
    expect(all.meta).toBeGreaterThan(1)
    expectSecondaryAfterTitle(all)
    expect(await squeezeFirstRow(win)).toEqual({
      titleCut: false,
      metaCut: true,
      metaOverflow: 'ellipsis',
      metaInside: true,
    })

    await palette.getByRole('combobox').fill('pane')
    await expect(palette.getByRole('option', { name: /pane/i }).first()).toBeVisible()
    expectSecondaryAfterTitle(await rowLayout(win))
  } finally {
    await app.close()
  }
})
