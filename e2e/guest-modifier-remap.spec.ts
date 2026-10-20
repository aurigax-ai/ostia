import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isMac } from './chords'
import { isolatedLaunch } from './dataHome'
import { changeSettings, openWorkspace } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const RECORDER = `<title>Keys page</title><input id="q" autofocus><script>
window.seen = []
for (const type of ['keydown', 'keyup']) {
  addEventListener(type, (e) => {
    const flags = [e.ctrlKey && 'c', e.altKey && 'a', e.metaKey && 'm', e.shiftKey && 's']
    window.seen.push(type + ' ' + e.key + ' ' + flags.filter(Boolean).join(''))
  }, true)
}
</script>`

type Modifier = 'Control' | 'Alt' | 'Meta'

const forgetKeys = (app: ElectronApplication, url: string) =>
  app.evaluate(async ({ webContents }, url) => {
    await webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
      ?.executeJavaScript('window.seen.length = 0')
  }, url)

const pressInPage = (
  app: ElectronApplication,
  url: string,
  modifier: Modifier | null,
  keyCode: string,
) =>
  app.evaluate(
    ({ webContents }, { url, modifier, keyCode }) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
      if (!guest) throw new Error('no browser page')
      guest.focus()
      const flag = modifier === 'Control' ? 'control' : modifier === 'Alt' ? 'alt' : 'meta'
      const held = modifier ? [flag as 'control' | 'alt' | 'meta'] : []
      const send = (type: 'keyDown' | 'keyUp', key: string, modifiers: typeof held) =>
        guest.sendInputEvent({ type, keyCode: key, modifiers })
      if (modifier) send('keyDown', modifier, held)
      send('keyDown', keyCode, held)
      send('keyUp', keyCode, held)
      if (modifier) send('keyUp', modifier, [])
    },
    { url, modifier, keyCode },
  )

const pageSaw = (app: ElectronApplication, url: string) =>
  app.evaluate(async ({ webContents }, url) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
    const seen = await guest?.executeJavaScript('window.seen.slice()')
    return seen as string[]
  }, url)

test('on macOS a web page receives the keys the modifier remap makes of the physical ones', async () => {
  test.skip(!isMac, 'the modifier remap is a macOS setting')
  test.setTimeout(90_000)
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(RECORDER)
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await changeSettings(win, {
      modifierRemap: { ControlLeft: 'command', MetaLeft: 'control', AltLeft: 'control' },
    })
    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill(url)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /Keys page/ })).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => pageSaw(app, url)).toEqual([])

    await forgetKeys(app, url)
    await pressInPage(app, url, 'Control', 'Y')
    await expect
      .poll(() => pageSaw(app, url))
      .toEqual(['keydown Meta m', 'keydown y m', 'keyup y m', 'keyup Meta '])

    await forgetKeys(app, url)
    await pressInPage(app, url, 'Meta', 'Y')
    await expect
      .poll(() => pageSaw(app, url))
      .toEqual(['keydown Control c', 'keydown y c', 'keyup y c', 'keyup Control '])

    await forgetKeys(app, url)
    await pressInPage(app, url, 'Alt', 'Y')
    await expect
      .poll(() => pageSaw(app, url))
      .toEqual(['keydown Control c', 'keydown y c', 'keyup y c', 'keyup Control '])

    await forgetKeys(app, url)
    await pressInPage(app, url, null, 'Y')
    await expect.poll(() => pageSaw(app, url)).toEqual(['keydown y ', 'keyup y '])
  } finally {
    await app.close()
    server.close()
  }
})
