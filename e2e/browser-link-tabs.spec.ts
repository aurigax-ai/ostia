import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, quitApp } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

const ROW = 60

const LINKS = ['blank', 'modifier', 'middle', 'menu', 'popup', 'script'] as const

type Link = (typeof LINKS)[number]

const rowOf = (link: Link): number => LINKS.indexOf(link) * ROW + ROW / 2

const SITE = `<!doctype html><title>site</title>
<style>a, button { position: fixed; left: 0; width: 300px; height: ${ROW - 10}px; display: block }</style>
<a href="/blank" target="_blank" style="top: ${rowOf('blank') - 25}px">blank</a>
<a href="/modifier" style="top: ${rowOf('modifier') - 25}px">modifier</a>
<a href="/middle" style="top: ${rowOf('middle') - 25}px">middle</a>
<a href="/menu" style="top: ${rowOf('menu') - 25}px">menu</a>
<button id="popup" style="top: ${rowOf('popup') - 25}px">popup</button>
<button id="script" style="top: ${rowOf('script') - 25}px">script</button>
<script>
document.getElementById('popup').addEventListener('click', () => {
  window.open('/authorize', 'signin', 'popup,width=420,height=520')
})
document.getElementById('script').addEventListener('click', () => {
  window.__opened = window.open('/opener')
})
addEventListener('message', (event) => { document.title = 'heard ' + event.data })
</script>`

const OPENER_PAGE = `<!doctype html><title>opener</title>
<script>if (window.opener) window.opener.postMessage('from-opened', '*')</script>`

function serve(): Promise<{ server: Server; site: string; referrers: Map<string, string> }> {
  const referrers = new Map<string, string>()
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    referrers.set(path, req.headers.referer ?? '')
    res.setHeader('content-type', 'text/html')
    if (path === '/') res.end(SITE)
    else if (path === '/opener') res.end(OPENER_PAGE)
    else res.end(`<!doctype html><title>${path.slice(1)}</title>`)
  })
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      ok({ server, site: `http://127.0.0.1:${port}`, referrers })
    }),
  )
}

const shownAddress = (win: Page) =>
  win.locator('.pane-slot:not([data-hidden]) .browser-address').first()

function addresses(win: Page): Promise<string[]> {
  return win
    .locator('.browser-address')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
}

function humanGuestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents, session }) =>
    webContents
      .getAllWebContents()
      .filter(
        (wc) =>
          wc.getType() === 'webview' &&
          wc.session === session.fromPartition('persist:ostia-browser'),
      )
      .map((wc) => wc.getURL()),
  )
}

function siteTitle(app: ElectronApplication, siteUrl: string): Promise<string> {
  return app.evaluate(({ webContents }, at) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL() === at)
    return guest?.getTitle() ?? ''
  }, siteUrl)
}

function closeWindowAt(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(({ BrowserWindow }, at) => {
    for (const popup of BrowserWindow.getAllWindows()) {
      if (popup.webContents.getURL() === at) popup.close()
    }
  }, url)
}

function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

type Press = 'left' | 'modifier' | 'middle' | 'right'

function press(app: ElectronApplication, siteUrl: string, link: Link, how: Press): Promise<void> {
  return app.evaluate(
    ({ webContents }, at) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === at.siteUrl)
      if (!guest) throw new Error('no site guest')
      const button = at.how === 'middle' ? 'middle' : at.how === 'right' ? 'right' : 'left'
      const modifiers: Electron.InputEvent['modifiers'] =
        at.how === 'modifier' ? [process.platform === 'darwin' ? 'meta' : 'control'] : []
      const event = { x: 40, y: at.y, button, clickCount: 1, modifiers } as const
      guest.sendInputEvent({ type: 'mouseDown', ...event })
      guest.sendInputEvent({ type: 'mouseUp', ...event })
    },
    { siteUrl, y: rowOf(link), how },
  )
}

function captureMenus(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ Menu }) => {
    const held = globalThis as { __menus?: Electron.Menu[] }
    held.__menus = []
    Menu.prototype.popup = function popup(this: Electron.Menu) {
      held.__menus?.push(this)
    }
  })
}

function chooseFromMenu(app: ElectronApplication, label: string): Promise<string[] | null> {
  return app.evaluate((_electron, wanted) => {
    const menu = (globalThis as { __menus?: Electron.Menu[] }).__menus?.at(-1)
    const item = menu?.items.find((i) => i.label === wanted)
    if (!menu || !item) return null
    ;(item.click as () => void)()
    return menu.items.map((i) => i.label)
  }, label)
}

test('the human’s link clicks and Open Link in New Tab open browser tabs with the page’s referrer; script windows stay popups with their opener', async () => {
  test.setTimeout(180_000)
  const { server, site, referrers } = await serve()
  const siteUrl = `${site}/`
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New browser tab' }).first().click()
    await expect(shownAddress(win)).toBeVisible({ timeout: 15_000 })
    await shownAddress(win).fill(siteUrl)
    await shownAddress(win).press('Enter')
    await expect.poll(() => humanGuestUrls(app), { timeout: 15_000 }).toContain(siteUrl)
    await captureMenus(app)

    const opensInBackground = async (url: string): Promise<void> => {
      await expect.poll(() => addresses(win), { timeout: 15_000 }).toContain(url)
      await expect.poll(() => humanGuestUrls(app), { timeout: 15_000 }).toContain(url)
      await expect(shownAddress(win)).toHaveValue(siteUrl)
    }

    await press(app, siteUrl, 'middle', 'middle')
    await opensInBackground(`${site}/middle`)

    await press(app, siteUrl, 'modifier', 'modifier')
    await opensInBackground(`${site}/modifier`)

    await press(app, siteUrl, 'menu', 'right')
    await expect
      .poll(() => chooseFromMenu(app, 'Open Link in New Tab'), { timeout: 15_000 })
      .toEqual(['Open Link in New Tab', 'Copy Link Address'])
    await opensInBackground(`${site}/menu`)

    await press(app, siteUrl, 'popup', 'left')
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(2)
    expect(await addresses(win)).not.toContain(`${site}/authorize`)
    await closeWindowAt(app, `${site}/authorize`)
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(1)

    await press(app, siteUrl, 'script', 'left')
    await expect.poll(() => siteTitle(app, siteUrl), { timeout: 15_000 }).toBe('heard from-opened')
    expect(await windowCount(app)).toBe(2)
    expect(await addresses(win)).not.toContain(`${site}/opener`)
    await closeWindowAt(app, `${site}/opener`)
    await expect.poll(() => windowCount(app), { timeout: 15_000 }).toBe(1)

    await press(app, siteUrl, 'blank', 'left')
    await expect(shownAddress(win)).toHaveValue(`${site}/blank`, { timeout: 15_000 })
    await expect.poll(() => humanGuestUrls(app), { timeout: 15_000 }).toContain(`${site}/blank`)
    expect(await windowCount(app)).toBe(1)
    expect(await humanGuestUrls(app)).toContain(siteUrl)
    for (const path of ['/middle', '/modifier', '/menu', '/blank']) {
      expect(referrers.get(path)).toBe(siteUrl)
    }
  } finally {
    await quitApp(app)
    server.close()
  }
})
