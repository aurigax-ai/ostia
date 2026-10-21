import { freshDataHome, isolatedLaunch } from './dataHome'
import { quitApp } from './helpers'
import { _electron as electron, expect, type Locator, type Page, test } from './test'

const WORKSPACES = 20

const railViewport = (win: Page): Locator =>
  win.locator('.rail-scroll > [data-slot="scroll-area-viewport"]')
const railScrollbar = (win: Page): Locator =>
  win.locator('.rail-scroll > [data-slot="scroll-area-scrollbar"]')

function fadeAt(viewport: Locator, edge: 't' | 'b'): Promise<number> {
  return viewport.evaluate((el, name) => {
    const probe = document.createElement('div')
    probe.style.position = 'absolute'
    probe.style.width = '0'
    probe.style.height = getComputedStyle(el).getPropertyValue(name)
    el.parentElement?.append(probe)
    const px = probe.getBoundingClientRect().height
    probe.remove()
    return px
  }, `--scroll-fade-${edge}`)
}

function opacityOf(scrollbar: Locator): Promise<number> {
  return scrollbar.evaluate((el) => Number(getComputedStyle(el).opacity))
}

async function gutter(win: Page): Promise<{ rows: number; gutter: number; bar: number }> {
  return railViewport(win).evaluate((viewport) => {
    const rows = viewport.querySelector('.workspaces')?.getBoundingClientRect()
    const bar = viewport.parentElement
      ?.querySelector('[data-slot="scroll-area-scrollbar"]')
      ?.getBoundingClientRect()
    return {
      rows: rows?.width ?? 0,
      gutter: Number.parseFloat(getComputedStyle(viewport).paddingInlineEnd),
      bar: bar && rows && bar.left >= rows.right ? bar.width : -1,
    }
  })
}

async function wheelOverRail(win: Page, dy: number): Promise<void> {
  const box = await railViewport(win).boundingBox()
  if (!box) throw new Error('rail viewport not shown')
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.wheel(0, dy)
}

test('sidebar scroll list: edges fade where rows continue, and the scrollbar shows only while scrolling in a fixed gutter', async () => {
  test.setTimeout(120_000)
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.deck-rail')).toBeVisible({ timeout: 15_000 })

    const newWorkspace = win.locator('.topbar').getByRole('button', { name: 'New workspace' })
    for (let i = 1; i <= WORKSPACES; i++) {
      await newWorkspace.click()
      await expect(win.locator('.rail-row')).toHaveCount(i)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 520))

    const viewport = railViewport(win)
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(200)
    await viewport.evaluate((el) => el.scrollTo({ top: 0 }))

    const scrollbar = railScrollbar(win)
    await expect(scrollbar).toBeAttached()
    await expect.poll(() => opacityOf(scrollbar)).toBe(0)
    await expect.poll(() => fadeAt(viewport, 't')).toBe(0)
    await expect.poll(() => fadeAt(viewport, 'b')).toBeGreaterThan(0)
    const atRest = await gutter(win)
    expect(atRest.gutter).toBeGreaterThan(0)
    expect(atRest.bar).toBe(atRest.gutter)
    await win.locator('.deck-rail').screenshot({ path: test.info().outputPath('sidebar-rest.png') })

    await wheelOverRail(win, 160)
    await expect.poll(() => opacityOf(scrollbar)).toBe(1)
    await expect.poll(() => fadeAt(viewport, 't')).toBeGreaterThan(0)
    await expect.poll(() => fadeAt(viewport, 'b')).toBeGreaterThan(0)
    expect(await gutter(win)).toEqual(atRest)
    await win
      .locator('.deck-rail')
      .screenshot({ path: test.info().outputPath('sidebar-scrolling.png') })

    await expect.poll(() => opacityOf(scrollbar)).toBe(0)
    expect(await gutter(win)).toEqual(atRest)

    await wheelOverRail(win, 5000)
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(1)
    await expect.poll(() => fadeAt(viewport, 'b')).toBe(0)
    await expect.poll(() => fadeAt(viewport, 't')).toBeGreaterThan(0)
    await win.locator('.deck-rail').screenshot({ path: test.info().outputPath('sidebar-end.png') })
  } finally {
    await quitApp(app)
  }
})
