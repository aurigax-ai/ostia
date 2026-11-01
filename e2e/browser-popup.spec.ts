import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { chords } from './chords'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, seedSettings } from './dataHome'
import { launchWindow, openWorkspace, quitApp, readPaneEnv } from './helpers'
import { type ElectronApplication, expect, type Page, test } from './test'

const CLI = resolve(__dirname, '../out/cli/index.js')
const COOKIE = 'ostia_provider=signed'
const TOKEN = 'token-123'

interface Seen {
  path: string
  cookie: string
}

interface Fixture {
  server: Server
  seen: Seen[]
  site: string
  provider: string
}

function sitePage(provider: string): string {
  const open = `window.__popupWindow = window.open('${provider}/authorize', 'signin', 'popup,width=420,height=520'); window.__popup = window.__popupWindow ? 'opened' : 'blocked'`
  return `<!doctype html><title>site</title>
<button id="signin" style="position:fixed;left:0;top:0;width:240px;height:120px">Sign in</button>
<script>
addEventListener('message', (e) => { document.title = 'signed-in ' + e.data + ' ' + e.origin })
document.getElementById('signin').addEventListener('click', () => { ${open} })
</script>`
}

function providerPage(site: string): string {
  return `<!doctype html><title>provider</title><p>provider</p>
<script>
window.__hasBridge = typeof window.ostia !== 'undefined'
addEventListener('message', (e) => { if (e.data === 'close') window.close() })
if (window.opener) window.opener.postMessage('${TOKEN}', '${site}')
</script>`
}

function serve(): Promise<Fixture> {
  const seen: Seen[] = []
  const fixture = { seen } as Fixture
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    seen.push({ path, cookie: req.headers.cookie ?? '' })
    if (path === '/set') res.setHeader('set-cookie', `${COOKIE}; Max-Age=3600; Path=/`)
    res.setHeader('content-type', 'text/html')
    if (path === '/authorize') res.end(providerPage(fixture.site))
    else if (path === '/set') res.end('<!doctype html><title>cookie set</title>')
    else res.end(sitePage(fixture.provider))
  })
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      fixture.server = server
      fixture.site = `http://localhost:${port}`
      fixture.provider = `http://127.0.0.1:${port}`
      ok(fixture)
    }),
  )
}

async function launch(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const launched = await launchWindow(dataHome)
  await openWorkspace(launched.win)
  return launched
}

async function openHumanTab(win: Page, url: string): Promise<void> {
  await win.getByRole('button', { name: 'New browser tab' }).first().click()
  await visit(win, url)
}

async function visit(win: Page, url: string): Promise<void> {
  const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
  await expect(address).toBeVisible({ timeout: 15_000 })
  await address.fill(url)
  await address.press('Enter')
}

type Profile = 'human' | 'agent'

function inGuest<T>(
  app: ElectronApplication,
  url: string,
  profile: Profile,
  script: string,
): Promise<T | null> {
  return app
    .evaluate(
      async ({ webContents }, at) => {
        const guest = webContents
          .getAllWebContents()
          .find(
            (wc) =>
              wc.getType() === 'webview' &&
              wc.getURL() === at.url &&
              wc.session.isPersistent() === (at.profile === 'human'),
          )
        return guest ? ((await guest.executeJavaScript(at.script)) as T) : null
      },
      { url, profile, script },
    )
    .catch(() => null)
}

function clickSignIn(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(({ webContents }, at) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL() === at && wc.session.isPersistent())
    if (!guest) throw new Error('no human guest')
    guest.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 })
    guest.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 })
  }, url)
}

interface PopupReport {
  title: string
  hasBridge: boolean
  parented: boolean
  sharesProfile: boolean
}

function popups(app: ElectronApplication, provider: string): Promise<PopupReport[]> {
  return app.evaluate(async ({ BrowserWindow, session }, prefix) => {
    const reports: PopupReport[] = []
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.getURL().startsWith(prefix)) continue
      reports.push({
        title: win.getTitle(),
        hasBridge: (await win.webContents.executeJavaScript('window.__hasBridge')) as boolean,
        parented: win.getParentWindow() !== null,
        sharesProfile: win.webContents.session === session.fromPartition('persist:ostia-browser'),
      })
    }
    return reports
  }, provider)
}

function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

interface Run {
  code: number
  out: string
  err: string
}

function runCli(
  env: Record<string, string>,
  args: string[],
): { child: ChildProcess; done: Promise<Run> } {
  const child = spawn(process.execPath, [CLI, 'browse', ...args], {
    env: { ...process.env, OSTIA_SOCKET: env.OSTIA_SOCKET, OSTIA_TOKEN: env.OSTIA_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString()
  })
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString()
  })
  const done = new Promise<Run>((ok, fail) => {
    child.on('error', fail)
    child.on('close', (code) => ok({ code: code ?? 1, out: out.trim(), err: err.trim() }))
  })
  return { child, done }
}

test('the human’s click in their own browser pane opens a sign-in popup the page can talk to', async () => {
  test.setTimeout(180_000)
  const { server, seen, site, provider } = await serve()
  const { app, win } = await launch(freshDataHome())
  try {
    await openHumanTab(win, `${provider}/set`)
    await expect.poll(() => seen.some((s) => s.path === '/set'), { timeout: 15_000 }).toBe(true)
    await visit(win, `${site}/`)
    const siteUrl = `${site}/`
    await expect
      .poll(() => inGuest<string>(app, siteUrl, 'human', 'document.title'), { timeout: 15_000 })
      .toBe('site')

    await clickSignIn(app, siteUrl)
    await expect
      .poll(() => inGuest<string>(app, siteUrl, 'human', 'document.title'), { timeout: 15_000 })
      .toBe(`signed-in ${TOKEN} ${provider}`)
    expect(seen.find((s) => s.path === '/authorize')?.cookie).toBe(COOKIE)

    const open = await popups(app, provider)
    expect(open).toHaveLength(1)
    expect(open[0].hasBridge).toBe(false)
    expect(open[0].parented).toBe(true)
    expect(open[0].sharesProfile).toBe(true)
    expect(open[0].title).toContain(new URL(provider).host)

    await inGuest(app, siteUrl, 'human', "window.__popupWindow.postMessage('close', '*'); 0")
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(1)

    await clickSignIn(app, siteUrl)
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(2)
    await win.locator('.pane-slot:not([data-hidden]) .browser-address').click()
    await win.keyboard.press(chords.closePane)
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(1)
  } finally {
    await quitApp(app)
    server.close()
  }
})

test('an agent’s click opens no popup, in its own pane or in the human’s', async () => {
  test.setTimeout(240_000)
  const { server, site } = await serve()
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...CANVAS_RENDERER_SETTINGS, capabilities: { grants: ['browse'] } })
  const { app, win } = await launch(dataHome)
  try {
    const envFile = join(dataHome, 'pane.env')
    await win.locator('.ghostty-host').first().click()
    await win.keyboard.type(`env | grep '^OSTIA_' > ${envFile}`)
    await win.keyboard.press('Enter')
    await expect
      .poll(() => existsSync(envFile) && readFileSync(envFile, 'utf8'))
      .toContain('OSTIA_TOKEN=')
    const paneEnv = readPaneEnv(envFile)
    const siteUrl = `${site}/`

    const opened = await runCli(paneEnv, ['open', siteUrl, '--json']).done
    expect(JSON.parse(opened.out).success).toBe(true)
    await expect
      .poll(() => inGuest<string>(app, siteUrl, 'agent', 'document.title'), { timeout: 15_000 })
      .toBe('site')
    const own = await runCli(paneEnv, ['click', '#signin', '--json']).done
    expect(JSON.parse(own.out).success).toBe(true)
    await expect
      .poll(() => inGuest<string>(app, siteUrl, 'agent', 'window.__popup'), { timeout: 15_000 })
      .toBe('blocked')

    await openHumanTab(win, siteUrl)
    await expect
      .poll(() => inGuest<string>(app, siteUrl, 'human', 'document.title'), { timeout: 15_000 })
      .toBe('site')
    const listed = await runCli(paneEnv, ['tab', '--json']).done
    const tabs = JSON.parse(listed.out).data.tabs as { tabId: string; profile?: string }[]
    const humanTab = tabs.find((t) => t.profile === 'shared')
    if (!humanTab) throw new Error('no shared tab listed')

    const drive = runCli(paneEnv, ['click', '#signin', '--pane', humanTab.tabId, '--json'])
    await win.getByRole('tab', { name: /Needs attention/ }).click()
    const card = win.getByRole('region', { name: 'Agent permission request' })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: 'Allow once' }).click()
    expect(JSON.parse((await drive.done).out).success).toBe(true)
    await expect
      .poll(() => inGuest<string>(app, siteUrl, 'human', 'window.__popup'), { timeout: 15_000 })
      .toBe('blocked')
    expect(await windowCount(app)).toBe(1)
  } finally {
    await quitApp(app)
    server.close()
  }
})
