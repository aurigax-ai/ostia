import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

async function recordNativeMenus(app: ElectronApplication): Promise<() => Promise<string[][]>> {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __menus: string[][] }
    g.__menus = []
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.__menus.push(
        this.items.map((i) => (i.type === 'separator' ? '-' : (i.role || i.label).toLowerCase())),
      )
    }
  })
  return () => app.evaluate(() => (globalThis as unknown as { __menus: string[][] }).__menus)
}

test('right-click in a terminal offers copy, paste, select all and clear', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()
    await win.keyboard.type('echo pine_menu_marker')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_menu_marker', { timeout: 15_000 })

    await win.locator('.xterm').first().click({ button: 'right' })
    await expect(win.getByRole('menuitem', { name: 'Paste' })).toBeVisible()
    await expect(win.getByRole('menuitem', { name: 'Select All' })).toBeVisible()
    await win.getByRole('menuitem', { name: 'Clear Terminal' }).click()
    await expect(rows).not.toContainText('pine_menu_marker', { timeout: 15_000 })
    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()

    await win.keyboard.type('echo pine_after_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_after_42', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('right-click in a text field and on a web page shows the native menu', async () => {
  test.setTimeout(60_000)
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<title>Menu page</title><p style="height:400px">blank space</p>')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address() as AddressInfo
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const menus = await recordNativeMenus(app)

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const search = win.getByRole('region', { name: 'Settings' }).getByRole('textbox').first()
    await search.fill('font')
    await search.click({ button: 'right' })
    await expect
      .poll(async () => (await menus()).at(-1) ?? [])
      .toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectall']))
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(async () => {
      await win.keyboard.press('Escape')
      await expect(settings).toHaveCount(0, { timeout: 1_000 })
    }).toPass()

    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill(`http://127.0.0.1:${port}/`)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /Menu page/ })).toBeVisible({ timeout: 15_000 })
    const before = (await menus()).length
    await app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview')
      if (!guest) throw new Error('no browser page')
      for (const type of ['mouseDown', 'mouseUp'] as const) {
        guest.sendInputEvent({ type, x: 60, y: 200, button: 'right', clickCount: 1 })
      }
    })
    await expect.poll(async () => (await menus()).length).toBeGreaterThan(before)
    expect((await menus()).at(-1)).toEqual(['back', 'forward', 'reload'])
  } finally {
    await app.close()
    server.close()
  }
})
