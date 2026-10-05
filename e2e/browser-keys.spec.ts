import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { chords, isMac } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

const keys = {
  focusAddress: isMac ? 'Meta+l' : 'Control+Shift+l',
  reload: isMac ? 'Meta+r' : 'Control+F5',
  back: isMac ? 'Meta+BracketLeft' : 'Control+Alt+ArrowLeft',
  find: chords.find,
}

async function clickPage(win: Page): Promise<void> {
  const view = win.locator('.pane-slot:not([data-hidden]) webview').first()
  const box = await view.boundingBox()
  if (!box) throw new Error('the browser pane has no page area')
  await win.mouse.click(box.x + 40, box.y + 40)
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

    await clickPage(win)
    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    await clickPage(win)
    const before = hits
    await win.keyboard.press(keys.reload)
    await expect.poll(() => hits).toBeGreaterThan(before)

    await clickPage(win)
    await win.keyboard.press(keys.focusAddress)
    await expect(address).toBeFocused()
    await address.fill(`http://127.0.0.1:${port}/two`)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /Second page/ })).toBeVisible({ timeout: 15_000 })
    await clickPage(win)
    await win.keyboard.press(keys.back)
    await expect(win.getByRole('tab', { name: /First page/ })).toBeVisible({ timeout: 15_000 })

    await clickPage(win)
    await win.keyboard.press(keys.find)
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

test('a browser key pressed in a terminal does nothing there and pastes nothing', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await app.evaluate(({ clipboard }) => clipboard.writeText('echo pine_should_not_paste'))
    await win.locator('.xterm').first().click()
    await win.keyboard.press(keys.reload)
    await win.keyboard.type('echo pine_after_$((40+2))')
    await win.keyboard.press('Enter')
    const rows = win.locator('.xterm-rows').first()
    await expect(rows).toContainText('pine_after_42', { timeout: 15_000 })
    await expect(rows).not.toContainText('pine_should_not_paste')
  } finally {
    await app.close()
  }
})
