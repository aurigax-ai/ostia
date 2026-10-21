import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, test } from './test'

const PAGE =
  '<!doctype html><html><head><title>Passkey fixture</title></head><body>fixture</body></html>'

const PLATFORM_ONLY = `(async () => {
  const started = performance.now()
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge: new Uint8Array(32),
        allowCredentials: [{ id: new Uint8Array(16), type: 'public-key', transports: ['internal', 'hybrid'] }],
        timeout: 60000,
      },
    })
    return { name: 'resolved', ms: performance.now() - started }
  } catch (e) {
    return { name: e.name, ms: performance.now() - started }
  }
})()`

const CAPABILITIES = `PublicKeyCredential.getClientCapabilities().then((c) => ({
  passkey: c.passkeyPlatformAuthenticator,
  hybrid: c.hybridTransport,
}))`

function serve(): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

test('a passkey request that only a platform or phone authenticator could answer fails at once', async () => {
  test.setTimeout(120_000)
  const server = await serve()
  const pageUrl = `http://localhost:${(server.address() as AddressInfo).port}/`
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.keyboard.press(chords.palette)
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
      .toBe('Passkey fixture')

    const outcome = await guestEval<{ name: string; ms: number }>(PLATFORM_ONLY)
    expect(outcome.name).toBe('NotAllowedError')
    expect(outcome.ms).toBeLessThan(1000)

    await expect(
      win.getByText('This browser does not support passkeys', { exact: false }),
    ).toBeVisible()

    expect(await guestEval<{ passkey: boolean; hybrid: boolean }>(CAPABILITIES)).toEqual({
      passkey: false,
      hybrid: false,
    })
  } finally {
    await app.close()
    server.close()
  }
})
