import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { _electron as electron, expect, test } from './test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'

const PAGE = `<!doctype html>
<html><head><title>Storage fixture</title></head>
<body>
  <p>stored</p>
  <script>
    document.cookie = 'flavor=oat; path=/'
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('lang', 'en')
    sessionStorage.setItem('step', '2')
  </script>
</body></html>`

function serve(): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

test('the storage panel shows and edits the page cookies, local and session storage', async () => {
  test.setTimeout(120_000)
  const server = await serve()
  const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
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
      .poll(() => guestEval<string | null>('localStorage.getItem("lang")'), { timeout: 15_000 })
      .toBe('en')

    await win.getByRole('button', { name: 'Show storage' }).click()
    const panel = win.getByRole('region', { name: 'Storage' })
    await expect(panel).toBeVisible()

    const cookies = panel.getByRole('table', { name: 'Cookies' })
    const flavor = cookies.getByRole('row').filter({ hasText: 'flavor' })
    await expect(flavor).toContainText('oat')
    await expect(flavor).toContainText('127.0.0.1')
    await expect(flavor).toContainText('Session')

    await panel.getByRole('tab', { name: /Local storage/ }).click()
    const local = panel.getByRole('table', { name: 'Local storage' })
    await expect(local.getByRole('row').filter({ hasText: 'theme' })).toContainText('dark')
    await expect(panel).toContainText(`Origin: ${pageUrl.replace(/\/$/, '')}`)

    await panel.getByRole('textbox', { name: 'Filter storage' }).fill('lang')
    await expect(local.getByRole('row').filter({ hasText: 'theme' })).toHaveCount(0)
    await panel.getByRole('textbox', { name: 'Filter storage' }).fill('')

    await panel.getByRole('button', { name: 'Edit theme' }).click()
    const edit = win.getByRole('dialog', { name: 'Edit theme' })
    await edit.getByRole('textbox', { name: 'Value' }).fill('light')
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => guestEval<string>('localStorage.getItem("theme")')).toBe('light')
    await expect(local.getByRole('row').filter({ hasText: 'theme' })).toContainText('light')

    await panel.getByRole('button', { name: 'Delete lang' }).click()
    await expect.poll(() => guestEval<string | null>('localStorage.getItem("lang")')).toBeNull()

    await panel.getByRole('tab', { name: /Session storage/ }).click()
    const session = panel.getByRole('table', { name: 'Session storage' })
    await expect(session.getByRole('row').filter({ hasText: 'step' })).toContainText('2')
    await panel.getByRole('button', { name: 'Clear all' }).click()
    const confirm = win.getByRole('dialog', { name: 'Clear session storage?' })
    await confirm.getByRole('button', { name: 'Clear' }).click()
    await expect.poll(() => guestEval<number>('sessionStorage.length')).toBe(0)
    await expect(session).toContainText('This page has nothing in session storage.')

    await panel.getByRole('tab', { name: /Cookies/ }).click()
    await panel.getByRole('button', { name: 'Delete flavor' }).click()
    await expect.poll(() => guestEval<string>('document.cookie')).toBe('')
  } finally {
    await app.close()
    server.close()
  }
})
