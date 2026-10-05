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
    await win.keyboard.press('Escape')

    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill(`http://127.0.0.1:${port}/`)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /Menu page/ })).toBeVisible({ timeout: 15_000 })
    const before = (await menus()).length
    const box = await win.locator('.pane-slot:not([data-hidden]) webview').first().boundingBox()
    if (!box) throw new Error('the browser pane has no page area')
    await win.mouse.click(box.x + 60, box.y + 200, { button: 'right' })
    await expect.poll(async () => (await menus()).length).toBeGreaterThan(before)
    expect((await menus()).at(-1)).toEqual(['back', 'forward', 'reload'])
  } finally {
    await app.close()
    server.close()
  }
})
