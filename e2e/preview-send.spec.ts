import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, startFakeAgent } from './fakeAgent'
import { openWorkspace } from './helpers'
import { textPdf } from './pdfFixture'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

const REPORT_REF = /@(\S*selection-\d+\.md)/

function crc32(bytes: Buffer): number {
  let c = ~0
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function solidPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([200, 60 + (x % 100), 40], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function launchWithHome(
  files: Record<string, string | Buffer>,
): Promise<{ app: ElectronApplication; win: Page }> {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, name), body)
  const bin = fakeAgentBin(dataHome)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH}` },
  })
  const win = await app.firstWindow()
  await openWorkspace(win)
  await startFakeAgent(win)
  return { app, win }
}

async function openFromFiles(win: Page, name: string): Promise<void> {
  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  await win.locator('.file-row').filter({ hasText: name }).click()
}

async function watchCursor(app: ElectronApplication): Promise<() => Promise<string | null>> {
  await app.evaluate(({ BrowserWindow }) => {
    const state = globalThis as { lastCursor?: string | null }
    state.lastCursor = null
    BrowserWindow.getAllWindows()[0].webContents.on('cursor-changed', (_event, type) => {
      state.lastCursor = type
    })
  })
  return () => app.evaluate(() => (globalThis as { lastCursor?: string | null }).lastCursor ?? null)
}

function cursorAt(win: Page, x: number, y: number): Promise<string | null> {
  return win.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py)
      return el ? getComputedStyle(el).cursor : null
    },
    [x, y] as const,
  )
}

async function sendAndReadReport(win: Page, note: string): Promise<string> {
  const panel = win.getByRole('region', { name: 'Send to agent' })
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByRole('radio')).toHaveCount(1)
  await panel.getByLabel('Note for the agent').fill(note)
  await panel.getByRole('button', { name: 'Send' }).click()
  await expect(win.getByText(/The report is at its prompt/)).toBeVisible({ timeout: 15_000 })
  const terminal = win.locator('.xterm-rows').first()
  await expect(terminal).toContainText(REPORT_REF, { timeout: 15_000 })
  const match = ((await terminal.textContent()) ?? '').match(REPORT_REF)
  expect(match).not.toBeNull()
  return readFileSync((match as RegExpMatchArray)[1], 'utf8')
}

test('select text in a file and send it to a terminal pane', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launchWithHome({
    'prices.ts': 'export const base = 10\nexport const tax = 0.2\nexport const total = 12\n',
  })
  try {
    await openFromFiles(win, 'prices.ts')
    const editor = win.locator('.monaco-editor').first()
    await expect(editor).toBeVisible({ timeout: 15_000 })
    await expect(editor.locator('.view-lines')).toContainText('export const tax')
    await editor.locator('.view-line').filter({ hasText: 'export const tax' }).click()
    await win.keyboard.press('Home')
    await win.keyboard.press('Shift+End')

    await win.keyboard.press('Control+Shift+E')

    const report = await sendAndReadReport(win, 'is this tax rate right?')
    expect(report).toMatch(/- File: \/\S+\/home\/prices\.ts\n/)
    expect(report).toContain('- Lines: 2:1-2:23')
    expect(report).toContain('```ts\nexport const tax = 0.2\n```')
    expect(report).toContain('is this tax rate right?')
  } finally {
    await app.close()
  }
})

test('open an image and send a dragged region to a terminal pane', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launchWithHome({ 'chart.png': solidPng(240, 120) })
  try {
    await openFromFiles(win, 'chart.png')
    const canvas = win.locator('.viewer-canvas')
    await expect(win.locator('.viewer-meta')).toHaveText('240 × 120', { timeout: 15_000 })
    await expect(win.getByText('Zoom 100%')).toBeVisible()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('image canvas has no box')
    const cursor = await watchCursor(app)

    await win.mouse.move(box.x + 20, box.y + 10)
    expect(await cursorAt(win, box.x + 20, box.y + 10)).toBe('crosshair')
    await expect.poll(cursor).toBe('crosshair')
    await win.mouse.down()
    await win.mouse.move(box.x + 80, box.y + 40, { steps: 4 })
    await win.mouse.move(box.x + box.width + 8, box.y + box.height + 8, { steps: 4 })
    expect(await cursorAt(win, box.x + box.width + 8, box.y + box.height + 8)).not.toBe('crosshair')
    await expect.poll(cursor).toBe('crosshair')
    await win.mouse.move(box.x + 120, box.y + 60, { steps: 4 })
    expect(await cursorAt(win, box.x + 120, box.y + 60)).toBe('crosshair')
    await win.mouse.up()
    await expect(win.locator('.viewer-region')).toBeVisible()
    expect(await cursorAt(win, box.x + 100, box.y + 50)).toBe('crosshair')

    await win.getByRole('button', { name: 'Send region to agent' }).click()
    const report = await sendAndReadReport(win, 'the bar is the wrong color')

    expect(report).toContain('# Image region: chart.png')
    expect(report).toContain('- Image size: 240 × 120 px')
    const region = report.match(/- Region: x (\d+), y (\d+), (\d+) × (\d+)/)
    expect(region).not.toBeNull()
    const [, , , w, h] = (region as RegExpMatchArray).map(Number)
    expect(w).toBeGreaterThanOrEqual(98)
    expect(h).toBeGreaterThanOrEqual(48)
    const snapshot = report.match(/- Snapshot: (\S+\.png)/)
    expect(snapshot).not.toBeNull()
    const png = (snapshot as RegExpMatchArray)[1]
    expect(existsSync(png)).toBe(true)
    expect(pngSize(readFileSync(png))).toEqual({ width: w, height: h })
  } finally {
    await app.close()
  }
})

test('open a PDF and send selected text with its page number', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launchWithHome({ 'invoice.pdf': textPdf('Hello Ostia PDF') })
  try {
    await openFromFiles(win, 'invoice.pdf')
    await expect(win.getByText('Page 1 of 1')).toBeVisible({ timeout: 15_000 })
    const span = win.locator('.pdf-text span').filter({ hasText: 'Hello Ostia PDF' })
    await expect(span).toHaveCount(1, { timeout: 15_000 })
    await span.selectText()

    await win.getByRole('button', { name: 'Send selected text to agent' }).click()
    const report = await sendAndReadReport(win, 'check the greeting')

    expect(report).toContain('# PDF text selection: invoice.pdf, page 1')
    expect(report).toContain('- Pages: 1 (1-based)')
    expect(report).toContain('Hello Ostia PDF')
  } finally {
    await app.close()
  }
})

test('a PDF shows the crop cursor only while selecting a region', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launchWithHome({ 'invoice.pdf': textPdf('Hello Ostia PDF') })
  try {
    await openFromFiles(win, 'invoice.pdf')
    await expect(win.getByText('Page 1 of 1')).toBeVisible({ timeout: 15_000 })
    const span = win.locator('.pdf-text span').filter({ hasText: 'Hello Ostia PDF' })
    await expect(span).toHaveCount(1, { timeout: 15_000 })
    const word = await span.boundingBox()
    if (!word) throw new Error('pdf text has no box')
    const wordX = word.x + word.width / 2
    const wordY = word.y + word.height / 2
    const cursor = await watchCursor(app)
    await win.mouse.move(wordX, wordY)
    await expect.poll(cursor).toBe('text')

    await win.getByRole('button', { name: 'Select a region' }).click()
    const layer = win.locator('.pdf-region-layer')
    const box = await layer.boundingBox()
    if (!box) throw new Error('pdf region layer has no box')
    expect(await cursorAt(win, wordX, wordY)).toBe('crosshair')

    await win.mouse.move(wordX, wordY)
    await expect.poll(cursor).toBe('crosshair')
    await win.mouse.move(box.x + 20, box.y + 20)
    await win.mouse.down()
    await win.mouse.move(box.x + 80, box.y + 60, { steps: 4 })
    await win.mouse.move(box.x - 8, box.y + 60, { steps: 4 })
    expect(await cursorAt(win, box.x - 8, box.y + 60)).not.toBe('crosshair')
    await expect.poll(cursor).toBe('crosshair')
    await win.mouse.move(box.x + 120, box.y + 90, { steps: 4 })
    await win.mouse.up()
    await expect(win.locator('.viewer-region')).toBeVisible()
    expect(await cursorAt(win, box.x + 60, box.y + 50)).toBe('crosshair')

    await win.getByRole('button', { name: 'Select a region' }).click()
    await expect(layer).toHaveCount(0)
    await win.mouse.move(wordX, wordY)
    await expect.poll(cursor).toBe('text')
  } finally {
    await app.close()
  }
})

async function pinch(win: Page, x: number, y: number, deltaY: number): Promise<void> {
  await win.mouse.move(x, y)
  await win.keyboard.down('Control')
  await win.mouse.wheel(0, deltaY)
  await win.keyboard.up('Control')
}

test('a pinch zooms the image around the pointer and a drag still selects', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launchWithHome({ 'chart.png': solidPng(1200, 800) })
  try {
    await openFromFiles(win, 'chart.png')
    const canvas = win.locator('.viewer-canvas')
    await expect(win.locator('.viewer-meta')).toHaveText('1200 × 800', { timeout: 15_000 })
    const before = await canvas.boundingBox()
    if (!before) throw new Error('image canvas has no box')
    const fitScale = before.width / 1200
    const x = before.x + before.width * 0.4
    const y = before.y + before.height * 0.6
    const content = { x: (x - before.x) / fitScale, y: (y - before.y) / fitScale }

    await pinch(win, x, y, -50)
    const zoomed = fitScale * Math.exp(0.5)
    await expect(win.locator('.viewer-zoom')).toHaveText(`Zoom ${Math.round(zoomed * 100)}%`)
    await expect.poll(async () => (await canvas.boundingBox())?.width).toBeCloseTo(1200 * zoomed, 0)
    const after = await canvas.boundingBox()
    if (!after) throw new Error('image canvas has no box')
    const scale = after.width / 1200
    expect(Math.abs((x - after.x) / scale - content.x)).toBeLessThan(2)
    expect(Math.abs((y - after.y) / scale - content.y)).toBeLessThan(2)
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
      ),
    ).toBe(1)

    await win.mouse.wheel(0, 60)
    await expect.poll(async () => (await canvas.boundingBox())?.y).toBeLessThan(after.y - 30)
    await expect(win.locator('.viewer-zoom')).toHaveText(`Zoom ${Math.round(zoomed * 100)}%`)

    const box = await canvas.boundingBox()
    if (!box) throw new Error('image canvas has no box')
    await win.mouse.move(x, y)
    await win.mouse.down()
    await win.mouse.move(x + 120, y + 60, { steps: 6 })
    await win.mouse.up()
    await win.getByRole('button', { name: 'Send region to agent' }).click()
    const report = await sendAndReadReport(win, 'zoomed in')
    const region = report.match(/- Region: x (\d+), y (\d+), (\d+) × (\d+)/)
    expect(region).not.toBeNull()
    const [, rx, ry, rw, rh] = (region as RegExpMatchArray).map(Number)
    expect(Math.abs(rx - (x - box.x) / scale)).toBeLessThanOrEqual(2)
    expect(Math.abs(ry - (y - box.y) / scale)).toBeLessThanOrEqual(2)
    expect(Math.abs(rw - 120 / scale)).toBeLessThanOrEqual(2)
    expect(Math.abs(rh - 60 / scale)).toBeLessThanOrEqual(2)
  } finally {
    await app.close()
  }
})

test('a pinch zooms the PDF page and a region drag still selects', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launchWithHome({ 'invoice.pdf': textPdf('Hello Ostia PDF') })
  try {
    await openFromFiles(win, 'invoice.pdf')
    await expect(win.getByText('Page 1 of 1')).toBeVisible({ timeout: 15_000 })
    const page = win.locator('.pdf-page')
    await expect(page).toBeVisible()
    const zoom = win.locator('.viewer-zoom')
    const start = await page.boundingBox()
    if (!start) throw new Error('pdf page has no box')
    const percent = async (): Promise<number> =>
      Number((await zoom.textContent())?.match(/\d+/)?.[0])
    const fit = await percent()

    await pinch(win, start.x + 40, start.y + 40, 40)
    await expect.poll(percent).toBe(Math.round(fit * Math.exp(-0.4)))
    await expect.poll(async () => (await page.boundingBox())?.width).toBeLessThan(start.width)

    await win.getByRole('button', { name: 'Select a region' }).click()
    const box = await win.locator('.pdf-region-layer').boundingBox()
    if (!box) throw new Error('pdf region layer has no box')
    await win.mouse.move(box.x + 10, box.y + 10)
    await win.mouse.down()
    await win.mouse.move(box.x + 70, box.y + 50, { steps: 6 })
    await win.mouse.up()
    const region = await win.locator('.viewer-region').boundingBox()
    if (!region) throw new Error('no region drawn')
    expect(Math.abs(region.width - 60)).toBeLessThan(6)
    expect(Math.abs(region.height - 40)).toBeLessThan(6)
  } finally {
    await app.close()
  }
})

test('the PDF region hint never moves the page under a drag', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launchWithHome({ 'invoice.pdf': textPdf('Hello Ostia PDF') })
  try {
    await openFromFiles(win, 'invoice.pdf')
    await expect(win.getByText('Page 1 of 1')).toBeVisible({ timeout: 15_000 })
    const page = win.locator('.pdf-page')
    await expect(page).toBeVisible()
    const shown = await page.boundingBox()
    if (!shown) throw new Error('pdf page has no box')

    await win.getByRole('button', { name: 'Select a region' }).click()
    const hint = win.getByText('Drag across the page to select a region.')
    await expect(hint).toBeVisible()
    const box = await page.boundingBox()
    if (!box) throw new Error('pdf page has no box')
    expect(box.y).toBe(shown.y)

    await win.mouse.move(box.x + 40, box.y + 60)
    await win.mouse.down()
    await win.mouse.move(box.x + 100, box.y + 100, { steps: 4 })
    await expect(hint).toHaveCount(0)
    expect((await page.boundingBox())?.y).toBe(box.y)
    await win.mouse.move(box.x + 140, box.y + 160, { steps: 4 })
    await win.mouse.up()

    const region = await win.locator('.viewer-region').boundingBox()
    if (!region) throw new Error('no region drawn')
    expect(Math.abs(region.y - (box.y + 60))).toBeLessThan(3)
    expect(Math.abs(region.height - 100)).toBeLessThan(3)
    expect(Math.abs(region.width - 100)).toBeLessThan(3)
  } finally {
    await app.close()
  }
})
