import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome, startFakeAgent } from './fakeAgent'
import { expectHeld, occurrences, openWorkspace, shownTerminal, terminalTab } from './helpers'
import { pngOf } from './pngFixture'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'
import { viewerGuestRun } from './viewerGuest'

const VIEW_TYPE = 'images.image'
const WIDTH = 1600
const HEIGHT = 1000
const DIVIDE = 800
const WIDE = { width: 5000, height: 3000 }
const WIDE_SENT = { width: 4096, height: 2458 }
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="red"/></svg>'

interface GuestEvent {
  type: 'mouseDown' | 'mouseMove' | 'mouseUp' | 'keyDown'
  x?: number
  y?: number
  button?: 'left'
  clickCount?: number
  keyCode?: string
  modifiers?: string[]
}

async function guestInput(
  app: ElectronApplication,
  name: string,
  events: GuestEvent[],
): Promise<void> {
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
    { wanted: { viewType: VIEW_TYPE, name }, input: events },
  )
  expect(sent).toBe(true)
}

function guestEval(app: ElectronApplication, name: string, script: string): Promise<unknown> {
  return viewerGuestRun(app, { viewType: VIEW_TYPE, name }, script)
}

async function openFile(win: Page, name: string): Promise<void> {
  await win.locator('.file-row').filter({ hasText: name }).click()
  await expect(win.locator('[data-testid="file-viewer"]:visible')).toHaveAttribute(
    'data-view-type',
    VIEW_TYPE,
    { timeout: 15_000 },
  )
}

async function expectNaturalWidth(
  app: ElectronApplication,
  name: string,
  width: number,
): Promise<void> {
  await expect
    .poll(() => guestEval(app, name, 'document.querySelector(".canvas img")?.naturalWidth ?? 0'), {
      timeout: 20_000,
    })
    .toBe(width)
}

async function canvasBox(
  app: ElectronApplication,
  name: string,
): Promise<{ left: number; top: number; width: number; height: number }> {
  const box = await guestEval(
    app,
    name,
    'JSON.stringify(document.querySelector(".canvas").getBoundingClientRect())',
  )
  return JSON.parse(String(box))
}

function clipboardPngSize(app: ElectronApplication) {
  return app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const item = items.find((entry) => entry.types.includes('image/png'))
    if (!item) return null
    const view = new DataView(await (await item.getType('image/png')).arrayBuffer())
    return { width: view.getUint32(16), height: view.getUint32(20) }
  })
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

test('images open in the viewer: a drag crops at native resolution and Send pastes the report without Enter; Ctrl+A selects the whole image, big photos are scaled down, a viewBox-only SVG renders, and a changed file reloads', async () => {
  test.setTimeout(240_000)
  const dataHome = freshDataHome()
  const home = isolatedHome(dataHome)
  writeFileSync(
    join(home, 'pic.png'),
    pngOf(WIDTH, HEIGHT, (x) => (x < DIVIDE ? [255, 0, 0] : [0, 0, 255])),
  )
  writeFileSync(
    join(home, 'wide.png'),
    pngOf(WIDE.width, WIDE.height, () => [10, 120, 200]),
  )
  writeFileSync(join(home, 'icon.svg'), ICON)
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
    await startFakeAgent(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    const bar = win.getByRole('toolbar', { name: 'Selection actions' })

    await test.step('a drag crops at native resolution and Send pastes the report with the note and no Enter', async () => {
      await openFile(win, 'pic.png')
      await expectNaturalWidth(app, 'pic.png', WIDTH)
      const box = await canvasBox(app, 'pic.png')
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
      await guestInput(app, 'pic.png', [
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
      await expect(bar).toBeVisible({ timeout: 15_000 })
      expect(
        await guestEval(app, 'pic.png', 'document.querySelector(".ostia-pill").dataset.state'),
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
      await expectHeld(
        async () => occurrences((await terminal.textContent()) ?? '', report),
        1,
        1_500,
      )
      const text = readFileSync(report, 'utf8')
      expect(text).toContain('Sharper edge here')
      const imagePath = text.match(/- Snapshot: (\S+\.png)/)?.[1] ?? ''
      expect(imagePath).not.toBe('')
      const bytes = readFileSync(imagePath)
      const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      expect(text).toContain(`- Sent image: ${size.width} × ${size.height} px\n`)
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
      await expect
        .poll(async () => occurrences((await terminal.textContent()) ?? '', report))
        .toBe(2)
    })

    await test.step('Ctrl+A selects the whole image, Ctrl+C alone does nothing, Esc clears, and a changed file reloads', async () => {
      await openFile(win, 'pic.png')
      await guestInput(app, 'pic.png', [{ type: 'keyDown', keyCode: 'C', modifiers: ['control'] }])
      await expectHeld(() => bar.count(), 0, 1_500)
      await guestInput(app, 'pic.png', [{ type: 'keyDown', keyCode: 'A', modifiers: ['control'] }])
      await expect(bar).toBeVisible({ timeout: 15_000 })
      await bar.getByRole('button', { name: 'Copy' }).click()
      await expect.poll(() => clipboardPngSize(app)).toEqual({ width: WIDTH, height: HEIGHT })
      await guestInput(app, 'pic.png', [{ type: 'keyDown', keyCode: 'Escape' }])
      await expect
        .poll(() => guestEval(app, 'pic.png', 'document.querySelector(".region").hidden'))
        .toBe(true)

      writeFileSync(
        join(home, 'pic.png'),
        pngOf(300, 200, () => [0, 255, 0]),
      )
      await expectNaturalWidth(app, 'pic.png', 300)
    })

    await test.step('a photo larger than the cap is scaled down and the report says the size sent', async () => {
      await openFile(win, 'wide.png')
      await expectNaturalWidth(app, 'wide.png', WIDE.width)
      await guestInput(app, 'wide.png', [{ type: 'keyDown', keyCode: 'A', modifiers: ['control'] }])
      await expect(bar).toBeVisible({ timeout: 15_000 })
      await bar.getByRole('button', { name: 'Copy' }).click()
      await expect.poll(() => clipboardPngSize(app), { timeout: 30_000 }).toEqual(WIDE_SENT)
    })

    await test.step('a viewBox-only SVG renders', async () => {
      await openFile(win, 'icon.svg')
      await expect
        .poll(
          () =>
            guestEval(
              app,
              'icon.svg',
              'JSON.stringify([document.querySelector(".canvas img")?.complete, document.querySelector(".canvas")?.getBoundingClientRect().width > 0, document.querySelector(".ostia-viewer-message")?.textContent ?? null])',
            ),
          { timeout: 20_000 },
        )
        .toBe(JSON.stringify([true, true, null]))
    })
  } finally {
    await app.close()
  }
})
