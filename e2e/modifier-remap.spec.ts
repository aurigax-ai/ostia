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

const inPage = <T>(app: ElectronApplication, url: string, code: string): Promise<T> =>
  app.evaluate(
    ({ webContents }, { url, code }) =>
      webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
        ?.executeJavaScript(code),
    { url, code },
  ) as Promise<T>

const pressInPage = (app: ElectronApplication, url: string, modifier: Modifier, keyCode: string) =>
  app.evaluate(
    ({ webContents }, { url, modifier, keyCode }) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
      if (!guest) throw new Error('no browser page')
      guest.focus()
      const flag = modifier === 'Control' ? 'control' : modifier === 'Alt' ? 'alt' : 'meta'
      guest.sendInputEvent({ type: 'keyDown', keyCode: modifier, modifiers: [flag] })
      for (const type of ['keyDown', 'keyUp'] as const) {
        guest.sendInputEvent({ type, keyCode, modifiers: [flag] })
      }
      guest.sendInputEvent({ type: 'keyUp', keyCode: modifier, modifiers: [] })
    },
    { url, modifier, keyCode },
  )

test('on macOS a remapped modifier key sends the bytes of the key it now stands for', async () => {
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
      terminal: { macOptionIsMeta: true },
      modifierRemap: {
        ControlRight: 'option',
        AltRight: 'control',
        AltLeft: 'command',
        MetaLeft: 'option',
      },
    })
    await win.locator('.ghostty-host').first().click()
    const rows = win.locator('.terminal-text').first()
    await win.keyboard.type('cat -v')
    await win.keyboard.press('Enter')

    await win.keyboard.down('ControlLeft')
    await win.keyboard.press('a')
    await win.keyboard.up('ControlLeft')
    await expect(rows).toContainText('^A')

    await win.keyboard.down('ControlRight')
    await win.keyboard.press('b')
    await win.keyboard.up('ControlRight')
    await expect(rows).toContainText('^[b')

    await win.keyboard.down('AltRight')
    await win.keyboard.press('c')
    await win.keyboard.up('AltRight')
    await expect(rows).toContainText('^C')

    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill(url)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /Keys page/ })).toBeVisible({ timeout: 15_000 })
    const seen = () => inPage<string[]>(app, url, 'window.seen.slice()')
    const forget = () => inPage<number>(app, url, 'window.seen.length = 0')

    await forget()
    await pressInPage(app, url, 'Alt', 'Y')
    await expect.poll(seen).toEqual(['keydown Meta m', 'keydown y m', 'keyup y m', 'keyup Meta '])
    expect(await inPage<string>(app, url, 'q.value')).toBe('')

    await forget()
    await pressInPage(app, url, 'Meta', 'Y')
    await expect.poll(seen).toEqual(['keydown Alt a', 'keydown y a', 'keyup y a', 'keyup Alt '])
    await expect.poll(() => inPage<string>(app, url, 'q.value')).toBe('y')
  } finally {
    await app.close()
    server.close()
  }
})
