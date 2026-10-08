import { chords } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const OLD_LIST_HEIGHT = 288
const OLD_DIALOG_WIDTH = 672

async function launch(theme: string) {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, appearance: { theme } })
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
  return { app, win }
}

async function measure(win: Page) {
  return win.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const list = document.querySelector('[data-slot="command-list"]')
    const heading = document.querySelector('[cmdk-group-heading]')
    const item = document.querySelector('[data-slot="command-item"]')
    const rows = [...document.querySelectorAll('[data-slot="palette-row"]')].map((row) => {
      const cells = [...row.children].map((cell) => cell.getBoundingClientRect())
      return {
        left: cells[0].left - row.getBoundingClientRect().left,
        gaps: cells.slice(1).map((cell, i) => cell.left - cells[i].right),
        overflow: Math.max(...cells.map((cell) => cell.right)) - row.getBoundingClientRect().right,
      }
    })
    const gaps = rows.flatMap((row) => row.gaps)
    const style = (el: Element | null) => (el ? getComputedStyle(el) : null)
    return {
      dialogWidth: dialog?.getBoundingClientRect().width ?? 0,
      listHeight: list?.getBoundingClientRect().height ?? 0,
      headingWeight: Number(style(heading)?.fontWeight ?? 0),
      headingSize: Number.parseFloat(style(heading)?.fontSize ?? '0'),
      itemSize: Number.parseFloat(style(item)?.fontSize ?? '0'),
      numeric:
        style(item?.querySelector('[data-slot="palette-row"]') ?? null)?.fontVariantNumeric ?? '',
      titleInset: Math.max(...rows.map((row) => Math.abs(row.left))),
      gapCount: gaps.length,
      gapMin: Math.min(...gaps),
      gapMax: Math.max(...gaps),
      overflow: Math.max(...rows.map((row) => row.overflow)),
      keyCount: document.querySelectorAll('[data-slot="palette-row"] > kbd').length,
      metaColors: [
        ...new Set(
          [
            ...document.querySelectorAll(
              '[data-slot="command-item"]:not([data-selected="true"]) [data-slot="palette-meta"]',
            ),
          ].map((el) => getComputedStyle(el).color),
        ),
      ],
      mutedColor: (() => {
        const probe = document.createElement('span')
        probe.className = 'text-fg-muted'
        document.body.append(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      })(),
    }
  })
}

async function squeezeFirstMeta(win: Page) {
  return win.evaluate(() => {
    const meta = document.querySelector<HTMLElement>('[data-slot="palette-meta"]')
    const row = meta?.closest<HTMLElement>('[data-slot="palette-row"]')
    const title = row?.querySelector<HTMLElement>('[data-slot="palette-title"]')
    const item = row?.closest<HTMLElement>('[data-slot="command-item"]')
    if (!meta || !row || !title || !item) return null
    const kept = item.style.width
    item.style.width = `${title.getBoundingClientRect().width + 80}px`
    const measured = {
      titleCut: title.scrollWidth > title.clientWidth,
      metaCut: meta.scrollWidth > meta.clientWidth,
      metaOverflow: getComputedStyle(meta).textOverflow,
      metaInside: meta.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5,
      metaStart: meta.getBoundingClientRect().left - title.getBoundingClientRect().right,
    }
    item.style.width = kept
    return measured
  })
}

function expectSecondaryAfterTitle(layout: Awaited<ReturnType<typeof measure>>): void {
  expect(layout.gapCount).toBeGreaterThan(0)
  expect(layout.titleInset).toBeLessThanOrEqual(0.5)
  expect(layout.gapMin).toBeGreaterThan(0)
  expect(layout.gapMax - layout.gapMin).toBeLessThanOrEqual(0.5)
  expect(layout.overflow).toBeLessThanOrEqual(0.5)
  expect(layout.metaColors).toEqual([layout.mutedColor])
}

for (const theme of ['adeberry', 'ostia-light']) {
  test(`the palette is taller and wider, headings stand out and secondary text follows the title on ${theme}`, async () => {
    const { app, win } = await launch(theme)
    try {
      await openWorkspace(win)
      await win.keyboard.press(chords.palette)
      const palette = win.getByRole('dialog', { name: 'Command palette' })
      await expect(palette).toBeVisible()
      await expect(palette.getByRole('option').first()).toBeVisible()
      await win.waitForTimeout(400)

      await test.info().attach(`palette-${theme}-all`, {
        body: await palette.screenshot(),
        contentType: 'image/png',
      })

      const all = await measure(win)
      expect(all.listHeight).toBeGreaterThanOrEqual(OLD_LIST_HEIGHT * 1.4)
      expect(all.dialogWidth).toBeGreaterThanOrEqual(OLD_DIALOG_WIDTH * 1.1)
      expect(all.headingWeight).toBeGreaterThanOrEqual(600)
      expect(all.headingSize).toBeGreaterThanOrEqual(all.itemSize)
      expect(all.numeric).toContain('tabular-nums')
      expect(all.keyCount).toBeGreaterThan(0)
      expectSecondaryAfterTitle(all)
      expect(await squeezeFirstMeta(win)).toEqual({
        titleCut: false,
        metaCut: true,
        metaOverflow: 'ellipsis',
        metaInside: true,
        metaStart: all.gapMin,
      })

      await palette.getByRole('combobox').fill('pane')
      await expect(palette.getByRole('option').first()).toBeVisible()
      await win.waitForTimeout(400)
      await test.info().attach(`palette-${theme}-search`, {
        body: await palette.screenshot(),
        contentType: 'image/png',
      })
      const searched = await measure(win)
      expectSecondaryAfterTitle(searched)
    } finally {
      await app.close()
    }
  })
}
