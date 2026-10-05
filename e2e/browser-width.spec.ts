import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

const CLI = resolve(__dirname, '../out/cli/index.js')

const PAGE = `<!doctype html>
<html><head><title>Width fixture</title><style>html,body{margin:0}</style></head>
<body><div style="width:100vw;height:20px;background:teal"></div>
<script>
  window.__widths = [innerWidth]
  addEventListener('load', () => window.__widths.push(innerWidth))
  addEventListener('resize', () => window.__widths.push(innerWidth))
</script></body></html>`

function serve(): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

interface Guest {
  url: string
  devicePixels: number
  innerWidth: number
  widths: number[]
}

function guests(app: ElectronApplication): Promise<Guest[]> {
  return app.evaluate(async ({ webContents }) => {
    const out: Guest[] = []
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getType() !== 'webview' || !wc.getURL().startsWith('http://127.0.0.1')) continue
      const page = await wc
        .executeJavaScript('({ innerWidth, widths: window.__widths || [] })')
        .catch(() => null)
      if (!page) continue
      out.push({
        url: wc.getURL(),
        devicePixels: Math.round(page.innerWidth * wc.getZoomFactor()),
        innerWidth: page.innerWidth,
        widths: page.widths,
      })
    }
    return out
  })
}

interface Host {
  width: number
  devicePixels: number
}

async function visibleHost(app: ElectronApplication, win: Page): Promise<Host | null> {
  const width = await win.evaluate(
    () =>
      document.querySelector('.pane-slot:not([data-hidden]) webview.browser-webview')
        ?.clientWidth ?? null,
  )
  if (width === null) return null
  const zoom = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  )
  return { width, devicePixels: Math.round(width * zoom) }
}

type Ostia = (...args: string[]) => Promise<{ code: number; out: string }>

async function launch(
  settings: object,
  args: string[] = [],
): Promise<{ app: ElectronApplication; win: Page; ostia: Ostia }> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    capabilities: { grants: ['browse'] },
    ...settings,
  })
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...options, args: [...args, ...options.args] })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  const envFile = join(dataHome, 'pane.env')
  await win.locator('.xterm').first().click()
  await win.keyboard.type(`env | grep '^PINE_' > ${envFile}`)
  await win.keyboard.press('Enter')
  await expect
    .poll(() => existsSync(envFile) && readFileSync(envFile, 'utf8'))
    .toContain('PINE_TOKEN=')
  const env: Record<string, string> = {}
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  const ostia: Ostia = (...cliArgs) =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, [CLI, 'browse', ...cliArgs], {
        env: { ...process.env, PINE_SOCKET: env.PINE_SOCKET, PINE_TOKEN: env.PINE_TOKEN },
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let out = ''
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString()
      })
      child.on('error', fail)
      child.on('close', (code) => done({ code: code ?? 1, out: out.trim() }))
    })
  return { app, win, ostia }
}

async function setWindowSize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.unmaximize()
      w.setContentSize(size.width, size.height)
    },
    { width, height },
  )
}

async function expectPageFitsPane(
  app: ElectronApplication,
  win: Page,
  path: string,
): Promise<Host> {
  let host: Host | null = null
  await expect
    .poll(
      async () => {
        const guest = (await guests(app)).find((g) => new URL(g.url).pathname === path)
        host = await visibleHost(app, win)
        if (!guest || !host) return 'no browser pane'
        return Math.abs(guest.devicePixels - host.devicePixels) <= 2
          ? 'fits'
          : `page ${guest.devicePixels}px in a ${host.devicePixels}px pane`
      },
      { timeout: 15_000 },
    )
    .toBe('fits')
  const guest = (await guests(app)).find((g) => new URL(g.url).pathname === path) as Guest
  expect(
    Math.max(...guest.widths),
    `the page was laid out at ${guest.widths.join(', ')}`,
  ).toBeLessThanOrEqual(guest.innerWidth)
  return host as unknown as Host
}

for (const [width, height] of [
  [1440, 900],
  [1000, 700],
]) {
  test(`a page opened by ostia browse open is laid out at its pane's width in a ${width}x${height} window`, async () => {
    test.setTimeout(120_000)
    const server = await serve()
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const { app, win, ostia } = await launch({})
    try {
      await setWindowSize(app, width, height)
      await expect.poll(() => win.evaluate(() => innerWidth)).toBe(width)

      expect((await ostia('open', `${origin}/first`)).code).toBe(0)
      const pane = await expectPageFitsPane(app, win, '/first')
      await expect
        .poll(async () => Number((await ostia('eval', 'window.innerWidth')).out))
        .toBe(pane.width)

      expect((await ostia('open', `${origin}/again`)).code).toBe(0)
      await expectPageFitsPane(app, win, '/again')

      await setWindowSize(app, width - 200, height)
      await expect.poll(async () => (await visibleHost(app, win))?.width).toBeLessThan(pane.width)
      await expect
        .poll(async () => Number((await ostia('eval', 'window.innerWidth')).out))
        .toBe((await visibleHost(app, win))?.width)
      await setWindowSize(app, width, height)
      await expect.poll(async () => (await visibleHost(app, win))?.width).toBe(pane.width)

      expect((await ostia('close')).code).toBe(0)
      await expect.poll(() => visibleHost(app, win)).toBeNull()
      expect((await ostia('open', `${origin}/reopened`)).code).toBe(0)
      expect((await expectPageFitsPane(app, win, '/reopened')).width).toBe(pane.width)
      expect((await ostia('close')).code).toBe(0)
      await expect.poll(() => visibleHost(app, win)).toBeNull()

      await win.getByRole('button', { name: 'New browser tab' }).click()
      const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
      await address.fill(`${origin}/human`)
      await address.press('Enter')
      const tab = await expectPageFitsPane(app, win, '/human')
      expect(tab.width).toBe(pane.width)
    } finally {
      await app.close()
      server.close()
    }
  })
}

test('a page opened by ostia browse open behind the settings cover fits its pane at 125% app zoom on a 2x display', async () => {
  test.setTimeout(120_000)
  const server = await serve()
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const { app, win, ostia } = await launch({ appearance: { zoom: 125 } }, [
    '--force-device-scale-factor=2',
  ])
  try {
    await setWindowSize(app, 1440, 900)
    await expect.poll(() => win.evaluate(() => devicePixelRatio)).toBe(2.5)

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible()
    expect((await ostia('open', `${origin}/covered`)).code).toBe(0)
    await expect.poll(async () => (await guests(app)).length, { timeout: 15_000 }).toBe(1)
    await win.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    const host = await expectPageFitsPane(app, win, '/covered')
    expect(host.devicePixels).toBeGreaterThan(host.width)
  } finally {
    await app.close()
    server.close()
  }
})
