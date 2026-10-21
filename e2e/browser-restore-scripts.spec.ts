import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, quitApp } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const PAGE =
  '<!doctype html><title>Restored fixture</title><script>window.__seenAtLoad = window.__ostiaErrCatcher === true</script><p>restored</p>'
const INLINE_URL = `data:text/html,${encodeURIComponent(PAGE)}`

function serve(requests: string[]): Promise<Server> {
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

function seenAtLoad(app: ElectronApplication, url: string): Promise<boolean | null> {
  return app
    .evaluate(async ({ webContents }, at) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === at)
      if (!guest) return null
      return (await guest.executeJavaScript('window.__seenAtLoad')) as boolean
    }, url)
    .catch(() => null)
}

function registerPageScriptsSlowly(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ app: electronApp }, delayMs) => {
    electronApp.on('web-contents-created', (_event, contents) => {
      const dbg = contents.debugger
      const send = dbg.sendCommand.bind(dbg)
      dbg.sendCommand = (method: string, ...rest: [object?, string?]) =>
        method === 'Page.addScriptToEvaluateOnNewDocument'
          ? new Promise((ok) => setTimeout(ok, delayMs)).then(() => send(method, ...rest))
          : send(method, ...rest)
    })
  }, 400)
}

async function restoredSeesScripts(pageUrl: string, loaded: () => boolean): Promise<void> {
  const dataHome = freshDataHome()
  const first = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await first.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New browser tab' }).first().click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await expect(address).toBeVisible({ timeout: 15_000 })
    await address.fill(pageUrl)
    await address.press('Enter')
    await expect.poll(() => seenAtLoad(first, pageUrl), { timeout: 15_000 }).toBe(true)
  } finally {
    await quitApp(first)
  }

  const second = await electron.launch(isolatedLaunch(dataHome))
  try {
    await registerPageScriptsSlowly(second)
    await expect.poll(loaded, { timeout: 30_000 }).toBe(true)
    await expect.poll(() => seenAtLoad(second, pageUrl), { timeout: 15_000 }).not.toBeNull()
    expect(await seenAtLoad(second, pageUrl)).toBe(true)
  } finally {
    await quitApp(second)
  }
}

test('a browser pane restored to a page that needs no network runs the page scripts before the page’s first script', async () => {
  test.setTimeout(180_000)
  await restoredSeesScripts(INLINE_URL, () => true)
})

test('a browser pane restored to a URL runs the page scripts before the page’s first script', async () => {
  test.setTimeout(180_000)
  const requests: string[] = []
  const server = await serve(requests)
  const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  try {
    await restoredSeesScripts(pageUrl, () => requests.filter((path) => path === '/').length > 1)
  } finally {
    server.close()
  }
})
