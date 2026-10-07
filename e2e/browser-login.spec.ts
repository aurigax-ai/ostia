import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, test } from './test'

const PAGE = `<!doctype html>
<html><head><title>Login fixture</title></head>
<body>
  <form>
    <input id="q" type="search">
    <input id="user" type="email" autocomplete="username">
    <input id="pass" type="password">
    <button type="button">Sign in</button>
  </form>
</body></html>`

function serve(): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

test('a login typed into a page is saved, then filled back from the key menu', async () => {
  test.setTimeout(120_000)
  const server = await serve()
  const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const launch = isolatedLaunch(freshDataHome())
  const app = await electron.launch({ ...launch, args: ['--password-store=basic', ...launch.args] })
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Open Browser')
    await waitForPaletteSelection(win, 'Open Browser')
    await win.keyboard.press('Enter')
    const address = win.getByRole('textbox', { name: 'Address' })
    await expect(address).toBeVisible({ timeout: 15_000 })
    await address.fill(pageUrl)
    await address.press('Enter')

    const guestEval = <T>(js: string): Promise<T> =>
      app.evaluate(
        async ({ webContents }, { url, code }) => {
          const guest = webContents
            .getAllWebContents()
            .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
          return guest ? await guest.executeJavaScript(code) : null
        },
        { url: pageUrl, code: js },
      ) as Promise<T>

    await expect
      .poll(() => guestEval<string | null>('document.title'), { timeout: 15_000 })
      .toBe('Login fixture')
    await guestEval(
      `document.getElementById('user').value = 'me@x.dev'; document.getElementById('pass').value = 's3cret'; true`,
    )

    const key = win.getByRole('button', { name: 'Passwords' })
    await key.click()
    await win.getByRole('button', { name: 'Save login from this page' }).click()
    await expect(win.getByText('Login saved.')).toBeVisible({ timeout: 10_000 })

    await guestEval('location.reload(); true')
    await expect
      .poll(() => guestEval<string | null>("document.getElementById('pass').value"), {
        timeout: 15_000,
      })
      .toBe('')

    await win.getByRole('button', { name: /saved login/ }).click()
    await win.getByRole('button', { name: 'me@x.dev' }).click()
    await expect
      .poll(() => guestEval<string | null>("document.getElementById('pass').value"), {
        timeout: 10_000,
      })
      .toBe('s3cret')
    expect(await guestEval<string>("document.getElementById('user').value")).toBe('me@x.dev')
    expect(await guestEval<string>("document.getElementById('q').value")).toBe('')
  } finally {
    await app.close()
    server.close()
  }
})
