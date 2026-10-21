import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome, startFakeAgent } from './fakeAgent'
import { occurrences, openWorkspace, shownTerminal, terminalTab } from './helpers'
import { pngOf } from './pngFixture'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'
import { viewerGuestRun } from './viewerGuest'

const IMAGE = { viewType: 'images.image', name: 'pic.png' }
const WIDTH = 1600
const HEIGHT = 1000
const DIVIDE = 800

const picture = pngOf(WIDTH, HEIGHT, (x) => (x < DIVIDE ? [255, 0, 0] : [0, 0, 255]))

interface GuestEvent {
  type: 'mouseDown' | 'mouseMove' | 'mouseUp' | 'keyDown'
  x?: number
  y?: number
  button?: 'left'
  clickCount?: number
  keyCode?: string
  modifiers?: string[]
}

async function guestInput(app: ElectronApplication, events: GuestEvent[]): Promise<void> {
  const sent = await app.evaluate(
    async ({ webContents }, { wanted, input }) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith('ostia-viewer://')) continue
        const meta = await contents
          .executeJavaScript('fetch("/~meta").then((r) => r.json())')
          .catch(() => null)
        if (meta?.viewType !== wanted.viewType || meta.name !== wanted.name) continue
        contents.focus()
        for (const event of input) contents.sendInputEvent(event as never)
        return true
      }
      return false
    },
    { wanted: IMAGE, input: events },
  )
  expect(sent).toBe(true)
}

async function withApp(
  run: (app: ElectronApplication, win: Page, home: string, dataHome: string) => Promise<void>,
): Promise<void> {
  const dataHome = freshDataHome()
  const home = isolatedHome(dataHome)
  writeFileSync(join(home, 'pic.png'), picture)
  const bin = fakeAgentBin(dataHome)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await run(app, win, home, dataHome)
  } finally {
    await app.close()
  }
}

async function openPicture(app: ElectronApplication, win: Page): Promise<void> {
  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  await win.locator('.file-row').filter({ hasText: 'pic.png' }).click()
  await expect(win.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
    'data-view-type',
    IMAGE.viewType,
    { timeout: 15_000 },
  )
  await expect
    .poll(
      () => viewerGuestRun(app, IMAGE, 'document.querySelector(".canvas img")?.naturalWidth ?? 0'),
      { timeout: 20_000 },
    )
    .toBe(WIDTH)
}

async function canvasBox(
  app: ElectronApplication,
): Promise<{ left: number; top: number; width: number; height: number }> {
  const box = await viewerGuestRun(
    app,
    IMAGE,
    'JSON.stringify(document.querySelector(".canvas").getBoundingClientRect())',
  )
  return JSON.parse(String(box))
}

function pixelsOf(app: ElectronApplication, path: string, points: [number, number][]) {
  return app.evaluate(
    ({ nativeImage }, { file, at }) => {
      const image = nativeImage.createFromPath(file)
      const { width } = image.getSize()
      const bitmap = image.toBitmap()
      return at.map(([x, y]) => {
        const offset = (y * width + x) * 4
        return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
      })
    },
    { file: path, at: points },
  )
}

test('an image fits the pane, a drag crops it at native resolution, and Send pastes the report with the note and no Enter', async () => {
  test.setTimeout(180_000)
  await withApp(async (app, win, _home) => {
    await startFakeAgent(win)
    await openPicture(app, win)
    const box = await canvasBox(app)
    expect(box.width).toBeLessThan(WIDTH)
    expect(box.width / box.height).toBeCloseTo(WIDTH / HEIGHT, 2)
    const scale = box.width / WIDTH

    const from = {
      x: Math.round(box.left + box.width * 0.4),
      y: Math.round(box.top + box.height * 0.3),
    }
    const to = {
      x: Math.round(box.left + box.width * 0.6),
      y: Math.round(box.top + box.height * 0.7),
    }
    const startX = Math.floor((from.x - box.left) / scale)
    const endX = Math.ceil((to.x - box.left) / scale)
    const startY = Math.floor((from.y - box.top) / scale)
    const endY = Math.ceil((to.y - box.top) / scale)
    await guestInput(app, [
      { type: 'mouseDown', ...from, button: 'left', clickCount: 1 },
      {
        type: 'mouseMove',
        x: Math.round((from.x + to.x) / 2),
        y: Math.round((from.y + to.y) / 2),
        button: 'left',
      },
      { type: 'mouseMove', ...to, button: 'left' },
      { type: 'mouseUp', ...to, button: 'left', clickCount: 1 },
    ])

    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    await expect(bar).toBeVisible({ timeout: 15_000 })
    expect(
      await viewerGuestRun(app, IMAGE, 'document.querySelector(".ostia-pill").dataset.state'),
    ).toBe('hidden')
    await bar.getByRole('button', { name: 'Add a note' }).click()
    await win.getByRole('textbox', { name: 'Add a note' }).fill('Sharper edge here')
    await bar.getByRole('button', { name: 'Send to agent' }).click()
    await win.getByRole('menuitem').first().click()
    await expect(bar).toHaveCount(0, { timeout: 15_000 })

    await terminalTab(win).click()
    const terminal = shownTerminal(win).locator('.xterm-rows')
    const inserted = /Sharper edge here @(\S+\.md)/
    await expect(terminal).toContainText(inserted, { timeout: 15_000 })
    const [, report] = ((await terminal.textContent()) ?? '').match(inserted) as RegExpMatchArray
    await win.waitForTimeout(800)
    expect(occurrences((await terminal.textContent()) ?? '', report)).toBe(1)
    const text = readFileSync(report, 'utf8')
    expect(text).toContain('Sharper edge here')
    const imagePath = text.match(/- Snapshot: (\S+\.png)/)?.[1] ?? ''
    expect(imagePath).not.toBe('')

    const bytes = readFileSync(imagePath)
    const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    expect(Math.abs(size.width - (endX - startX))).toBeLessThanOrEqual(1)
    expect(Math.abs(size.height - (endY - startY))).toBeLessThanOrEqual(1)
    expect(size.width).toBeGreaterThan(box.width * 0.2)
    const divide = DIVIDE - startX
    const row = Math.floor(size.height / 2)
    expect(
      await pixelsOf(app, imagePath, [
        [divide - 4, row],
        [divide + 4, row],
      ]),
    ).toEqual([
      [255, 0, 0],
      [0, 0, 255],
    ])

    await win.locator('.xterm').first().click()
    await win.keyboard.press('Enter')
    await expect.poll(async () => occurrences((await terminal.textContent()) ?? '', report)).toBe(2)
  })
})

test('the pill zooms and toggles the grid, Ctrl+C and Ctrl+A select the whole image, Esc clears it, and a changed file reloads', async () => {
  test.setTimeout(180_000)
  await withApp(async (app, win, home) => {
    await openPicture(app, win)
    const click = (label: string) =>
      viewerGuestRun(app, IMAGE, `document.querySelector('[aria-label="${label}"]').click()`)
    const zoomText = () =>
      viewerGuestRun(app, IMAGE, 'document.querySelector(".ostia-pill-menu-text").textContent')

    const fitted = (await canvasBox(app)).width
    expect(fitted).toBeLessThan(WIDTH)
    await click('Actual size')
    await expect.poll(async () => (await canvasBox(app)).width).toBe(WIDTH)
    expect(await zoomText()).toBe('100%')
    await click('Zoom in')
    await expect.poll(async () => (await canvasBox(app)).width).toBe(WIDTH * 1.25)
    expect(await zoomText()).toBe('125%')
    await click('Fit to pane')
    await expect.poll(async () => (await canvasBox(app)).width).toBeCloseTo(fitted, 0)
    await click('Show transparency grid')
    expect(await viewerGuestRun(app, IMAGE, 'document.querySelector(".canvas").dataset.grid')).toBe(
      'on',
    )

    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    await guestInput(app, [{ type: 'keyDown', keyCode: 'C', modifiers: ['control'] }])
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await guestInput(app, [{ type: 'keyDown', keyCode: 'Escape' }])
    await expect(bar).toHaveCount(0)
    expect(await viewerGuestRun(app, IMAGE, 'document.querySelector(".region").hidden')).toBe(true)

    await guestInput(app, [{ type: 'keyDown', keyCode: 'A', modifiers: ['control'] }])
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: 'Copy' }).click()
    await expect
      .poll(() =>
        app.evaluate(async ({ clipboard }) => {
          const items = await clipboard.read()
          const item = items.find((entry) => entry.types.includes('image/png'))
          if (!item) return null
          const view = new DataView(await (await item.getType('image/png')).arrayBuffer())
          return { width: view.getUint32(16), height: view.getUint32(20) }
        }),
      )
      .toEqual({ width: WIDTH, height: HEIGHT })

    writeFileSync(
      join(home, 'pic.png'),
      pngOf(300, 200, () => [0, 255, 0]),
    )
    await expect
      .poll(
        () =>
          viewerGuestRun(app, IMAGE, 'document.querySelector(".canvas img")?.naturalWidth ?? 0'),
        { timeout: 20_000 },
      )
      .toBe(300)
  })
})
