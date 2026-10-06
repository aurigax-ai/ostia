import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { chords } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, openWorkspace } from './helpers'

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
    const rightEdges = (selector: string) =>
      [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect().right)
    const metaEdges = rightEdges('[data-slot="command-item"] [data-slot="palette-meta"]')
    const keyEdges = rightEdges('[data-slot="command-item"] kbd')
    const style = (el: Element | null) => (el ? getComputedStyle(el) : null)
    return {
      dialogWidth: dialog?.getBoundingClientRect().width ?? 0,
      listHeight: list?.getBoundingClientRect().height ?? 0,
      headingWeight: Number(style(heading)?.fontWeight ?? 0),
      headingSize: Number.parseFloat(style(heading)?.fontSize ?? '0'),
      itemSize: Number.parseFloat(style(item)?.fontSize ?? '0'),
      numeric: style(item?.querySelector('span.grid') ?? null)?.fontVariantNumeric ?? '',
      metaSpread: metaEdges.length ? Math.max(...metaEdges) - Math.min(...metaEdges) : 0,
      keySpread: keyEdges.length ? Math.max(...keyEdges) - Math.min(...keyEdges) : 0,
      keyCount: keyEdges.length,
    }
  })
}

for (const theme of ['adeberry', 'ostia-light']) {
  test(`the palette is taller and wider, headings stand out and right-hand values align on ${theme}`, async () => {
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
      expect(all.metaSpread).toBeLessThanOrEqual(1)
      expect(all.keySpread).toBeLessThanOrEqual(1)

      await palette.getByRole('combobox').fill('pane')
      await expect(palette.getByRole('option').first()).toBeVisible()
      await win.waitForTimeout(400)
      await test.info().attach(`palette-${theme}-search`, {
        body: await palette.screenshot(),
        contentType: 'image/png',
      })
      const searched = await measure(win)
      expect(searched.metaSpread).toBeLessThanOrEqual(1)
      expect(searched.keySpread).toBeLessThanOrEqual(1)
    } finally {
      await app.close()
    }
  })
}
