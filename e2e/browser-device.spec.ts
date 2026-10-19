import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, quitApp } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

const PAGE = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Device fixture</title>
<script>
window.__touches = 0
window.__clicks = 0
addEventListener('touchstart', () => { window.__touches += 1 }, { passive: true })
addEventListener('click', () => { window.__clicks += 1 })
window.__report = () => ({
  width: innerWidth,
  height: innerHeight,
  dpr: devicePixelRatio,
  coarse: matchMedia('(pointer: coarse)').matches,
  ua: navigator.userAgent,
  touches: window.__touches,
  clicks: window.__clicks,
  scroll: scrollY,
})
</script></head>
<body style="margin:0;height:300vh;background:#fff">device</body></html>`

interface Report {
  width: number
  height: number
  dpr: number
  coarse: boolean
  ua: string
  touches: number
  clicks: number
  scroll: number
}

function serve(agents: string[]): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === '/') agents.push(req.headers['user-agent'] ?? '')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

function report(app: ElectronApplication, url: string): Promise<Report | null> {
  return app
    .evaluate(async ({ webContents }, at) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === at)
      if (!guest) return null
      const read = guest.executeJavaScript('typeof __report === "function" ? __report() : null')
      const late = new Promise<null>((ok) => setTimeout(() => ok(null), 2000))
      return (await Promise.race([read, late])) as Report | null
    }, url)
    .catch(() => null)
}

function capturedRatio(app: ElectronApplication, url: string): Promise<number | null> {
  return app
    .evaluate(async ({ webContents }, at) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === at)
      if (!guest) return null
      const { width, height } = (await guest.capturePage()).getSize()
      return width / height
    }, url)
    .catch(() => null)
}

function runInPage(app: ElectronApplication, url: string, code: string): Promise<unknown> {
  return app.evaluate(
    ({ webContents }, { at, js }) =>
      webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === at)
        ?.executeJavaScript(js),
    { at: url, js: code },
  )
}

function reloadGuest(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(({ webContents }, at) => {
    webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL() === at)
      ?.reload()
  }, url)
}

const pane = (win: Page) => win.locator('.pane-slot:not([data-hidden])')

async function pickPreset(win: Page, title: string): Promise<void> {
  await pane(win).getByLabel('Device', { exact: true }).click()
  await win.getByRole('option', { name: title, exact: true }).click()
}

async function dragBy(win: Page, edge: string, dx: number, dy: number): Promise<void> {
  const box = await pane(win).locator(`[data-edge="${edge}"]`).boundingBox()
  if (!box) throw new Error(`no ${edge} handle`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await win.mouse.move(x, y)
  await win.mouse.down()
  for (let step = 1; step <= 5; step++)
    await win.mouse.move(x + (dx * step) / 5, y + (dy * step) / 5)
  await win.mouse.up()
}

async function dragPage(win: Page, dy: number): Promise<void> {
  const box = await pane(win).locator('.browser-device-touch').boundingBox()
  if (!box) throw new Error('no touch layer')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await win.mouse.move(x, y)
  await win.mouse.down()
  for (let step = 1; step <= 10; step++) await win.mouse.move(x, y + (dy * step) / 10)
  await win.mouse.up()
}

test('device mode shows a page as a phone, rotates, resizes, survives reload and restart, and turns off', async () => {
  test.setTimeout(240_000)
  const agents: string[] = []
  const server = await serve(agents)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const dataHome = freshDataHome()
  const first = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await first.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New browser tab' }).first().click()
    const address = pane(win).locator('.browser-address')
    await expect(address).toBeVisible({ timeout: 15_000 })
    await address.fill(url)
    await address.press('Enter')
    await expect.poll(() => report(first, url), { timeout: 15_000 }).not.toBeNull()
    const desktop = (await report(first, url)) as Report
    expect(desktop).toMatchObject({ dpr: 1, coarse: false })
    expect(desktop.ua).not.toContain('iPhone')

    await pane(win).getByRole('button', { name: 'Device mode' }).click()
    const width = pane(win).getByRole('spinbutton', { name: 'Width' })
    await expect(width).toHaveValue('400')
    await expect.poll(async () => (await report(first, url))?.width).toBe(400)
    await dragBy(win, 'right', 40, 0)
    const dragged = Number(await width.inputValue())
    expect(dragged).toBeGreaterThan(400)
    await expect.poll(async () => (await report(first, url))?.width).toBe(dragged)

    await pickPreset(win, 'iPhone 16')
    await expect
      .poll(() => report(first, url), { timeout: 15_000 })
      .toMatchObject({
        width: 393,
        height: 852,
        dpr: 3,
        coarse: true,
        ua: expect.stringContaining('iPhone'),
      })
    await expect.poll(() => agents.at(-1)).toContain('iPhone')
    await expect
      .poll(() => capturedRatio(first, url), { timeout: 15_000 })
      .toBeCloseTo(393 / 852, 1)

    await pane(win).locator('.browser-device-touch').click()
    await expect.poll(() => report(first, url)).toMatchObject({ touches: 1, clicks: 1, scroll: 0 })
    await dragPage(win, -200)
    await expect.poll(async () => (await report(first, url))?.scroll).toBeGreaterThan(0)
    expect((await report(first, url))?.clicks).toBe(1)
    await expect
      .poll(async () => {
        await runInPage(first, url, 'scrollTo(0, 0)')
        return (await report(first, url))?.scroll
      })
      .toBe(0)
    await win.mouse.wheel(0, 400)
    await expect.poll(async () => (await report(first, url))?.scroll).toBeGreaterThan(0)

    await pane(win).getByRole('button', { name: 'Rotate' }).click()
    await expect
      .poll(() => report(first, url))
      .toMatchObject({ width: 852, height: 393, dpr: 3, coarse: true })

    await reloadGuest(first, url)
    await expect
      .poll(() => report(first, url), { timeout: 15_000 })
      .toMatchObject({ width: 852, height: 393, dpr: 3, ua: expect.stringContaining('iPhone') })
  } finally {
    await quitApp(first)
  }

  agents.length = 0
  const second = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await second.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect
      .poll(() => report(second, url), { timeout: 30_000 })
      .toMatchObject({
        width: 852,
        height: 393,
        dpr: 3,
        coarse: true,
        ua: expect.stringContaining('iPhone'),
      })
    await expect.poll(() => agents.at(-1)).toContain('iPhone')

    await pane(win).getByRole('button', { name: 'Exit device mode' }).click()
    await expect(pane(win).getByRole('toolbar', { name: 'Device mode settings' })).toHaveCount(0)
    await expect
      .poll(() => report(second, url), { timeout: 15_000 })
      .toMatchObject({ dpr: 1, coarse: false, ua: expect.not.stringContaining('iPhone') })
    const off = (await report(second, url)) as Report
    expect(off.width).toBeGreaterThan(852)
    expect(agents.at(-1)).not.toContain('iPhone')
  } finally {
    await quitApp(second)
    server.close()
  }
})
