import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, startFakeAgent } from './fakeAgent'
import { openWorkspace } from './helpers'
import { textPdf } from './pdfFixture'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

const REPORT_REF = /@(\S*selection-\d+\.md)/

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
