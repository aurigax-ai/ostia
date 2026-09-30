import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, startFakeAgent } from './fakeAgent'
import { openWorkspace } from './helpers'

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

function textPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
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

    await win.mouse.move(box.x + 20, box.y + 10)
    await win.mouse.down()
    await win.mouse.move(box.x + 80, box.y + 40, { steps: 4 })
    await win.mouse.move(box.x + 120, box.y + 60, { steps: 4 })
    await win.mouse.up()
    await expect(win.locator('.viewer-region')).toBeVisible()

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
  const { app, win } = await launchWithHome({ 'invoice.pdf': textPdf('Hello Pine PDF') })
  try {
    await openFromFiles(win, 'invoice.pdf')
    await expect(win.getByText('Page 1 of 1')).toBeVisible({ timeout: 15_000 })
    const span = win.locator('.pdf-text span').filter({ hasText: 'Hello Pine PDF' })
    await expect(span).toHaveCount(1, { timeout: 15_000 })
    await span.selectText()

    await win.getByRole('button', { name: 'Send selected text to agent' }).click()
    const report = await sendAndReadReport(win, 'check the greeting')

    expect(report).toContain('# PDF text selection: invoice.pdf, page 1')
    expect(report).toContain('- Pages: 1 (1-based)')
    expect(report).toContain('Hello Pine PDF')
  } finally {
    await app.close()
  }
})
