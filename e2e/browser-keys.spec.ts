import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isMac } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

interface GuestKey {
  keyCode: string
  modifiers: string[]
}

const mod = isMac ? ['meta'] : ['control', 'shift']
const pageKeys: Record<'palette' | 'focusAddress' | 'reload' | 'back' | 'find', GuestKey> = {
  palette: { keyCode: isMac ? 'K' : 'P', modifiers: mod },
  focusAddress: { keyCode: 'L', modifiers: mod },
  reload: isMac ? { keyCode: 'R', modifiers: mod } : { keyCode: 'F5', modifiers: ['control'] },
  back: isMac ? { keyCode: '[', modifiers: mod } : { keyCode: 'Left', modifiers: ['alt'] },
  find: { keyCode: 'F', modifiers: mod },
}

const terminalReload = isMac ? 'Meta+r' : 'Control+F5'

async function pressInPage(app: ElectronApplication, key: GuestKey): Promise<void> {
  await app.evaluate(({ webContents }, k) => {
    const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview')
    if (!guest) throw new Error('no browser page')
    guest.focus()
    for (const type of ['keyDown', 'keyUp'] as const) {
      guest.sendInputEvent({
        type,
        keyCode: k.keyCode,
        modifiers: k.modifiers as Electron.InputEvent['modifiers'],
      })
    }
  }, key)
}

test('inside a web page, Ostia shortcuts still work and browser keys drive the pane', async () => {
  test.setTimeout(90_000)
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.setHeader('content-type', 'text/html')
    if (req.url === '/two') res.end('<title>Second page</title><p>second</p>')
    else res.end('<title>First page</title><input id="q" autofocus><p>needle in a page</p>')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address() as AddressInfo
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill(`http://127.0.0.1:${port}/`)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /First page/ })).toBeVisible({ timeout: 15_000 })

    await pressInPage(app, pageKeys.palette)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    const before = hits
    await pressInPage(app, pageKeys.reload)
    await expect.poll(() => hits).toBeGreaterThan(before)

    await pressInPage(app, pageKeys.focusAddress)
    await expect(address).toBeFocused()
    await address.fill(`http://127.0.0.1:${port}/two`)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /Second page/ })).toBeVisible({ timeout: 15_000 })
    await pressInPage(app, pageKeys.back)
    await expect(win.getByRole('tab', { name: /First page/ })).toBeVisible({ timeout: 15_000 })

    await pressInPage(app, pageKeys.find)
    const find = win.getByRole('textbox', { name: 'Find in page' })
    await expect(find).toBeFocused()
    await find.fill('needle')
    await expect(win.locator('.browser-find .term-find-count')).toHaveText('1/1')
    await find.press('Escape')
    await expect(find).toBeHidden()
  } finally {
    await app.close()
    server.close()
  }
})

test('a browser key pressed in a terminal goes to the shell as an unbound key and pastes nothing', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await app.evaluate(({ clipboard }) => clipboard.writeText('echo ostia_should_not_paste'))
    await win.locator('.xterm').first().click()
    await win.keyboard.press(terminalReload)
    const rows = win.locator('.xterm-rows').first()
    await win.waitForTimeout(500)
    await expect(rows).not.toContainText('ostia_should_not_paste')
    await win.keyboard.press('Control+u')
    await win.keyboard.type('echo ostia_after_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_after_42', { timeout: 15_000 })
    await expect(rows).not.toContainText('ostia_should_not_paste')
  } finally {
    await app.close()
  }
})

test('on Linux, Ctrl+L and Ctrl+R drive a browser pane', async () => {
  test.skip(isMac, 'Ctrl+L and Ctrl+R are only bound on Linux')
  test.setTimeout(90_000)
  let hits = 0
  const server = createServer((_req, res) => {
    hits++
    res.setHeader('content-type', 'text/html')
    res.end('<title>Plain page</title><p>plain</p>')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address() as AddressInfo
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill(`http://127.0.0.1:${port}/`)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /Plain page/ })).toBeVisible({ timeout: 15_000 })

    const before = hits
    await pressInPage(app, { keyCode: 'R', modifiers: ['control'] })
    await expect.poll(() => hits).toBeGreaterThan(before)

    await win.locator('.pane-slot:not([data-hidden]) .browser-address').blur()
    await pressInPage(app, { keyCode: 'L', modifiers: ['control'] })
    await expect(address).toBeFocused()
  } finally {
    await app.close()
    server.close()
  }
})

test('on Linux, Ctrl+L and Ctrl+R in a terminal still reach the shell', async () => {
  test.skip(isMac, 'the Linux shell keys are covered here; macOS has no Ctrl+L or Ctrl+R chord')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()
    await win.keyboard.type('echo ostia_marker_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_marker_42', { timeout: 15_000 })

    await win.keyboard.press('Control+l')
    await expect(rows).not.toContainText('ostia_marker_42', { timeout: 15_000 })

    await win.keyboard.press('Control+r')
    await expect(rows).toContainText(/i-search/, { timeout: 15_000 })
    await win.keyboard.type('ostia_marker')
    await expect(rows).toContainText('ostia_marker_', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
