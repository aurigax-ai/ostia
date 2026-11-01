import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { addTab, openWorkspace, quitApp, typeLine } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

const SITE = `<!doctype html><title>site</title>
<style>a { position: fixed; left: 0; width: 300px; height: 50px; display: block }</style>
<a href="/one" style="top: 5px">one</a>
<a href="/two" style="top: 65px">two</a>`

function ctrlClick(app: ElectronApplication, siteUrl: string, y: number): Promise<void> {
  return app.evaluate(
    ({ webContents }, at) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === at.siteUrl)
      if (!guest) throw new Error('no site guest')
      const modifiers: Electron.InputEvent['modifiers'] = [
        process.platform === 'darwin' ? 'meta' : 'control',
      ]
      const event = { x: 40, y: at.y, button: 'left', clickCount: 1, modifiers } as const
      guest.sendInputEvent({ type: 'mouseDown', ...event })
      guest.sendInputEvent({ type: 'mouseUp', ...event })
    },
    { siteUrl, y },
  )
}

function siteLoaded(app: ElectronApplication, siteUrl: string): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, at) =>
      webContents
        .getAllWebContents()
        .some((wc) => wc.getType() === 'webview' && wc.getURL() === at && !wc.isLoading()),
    siteUrl,
  )
}

const tabs = (win: Page) => win.getByRole('tablist').getByRole('tab')

async function closeTab(win: Page, index: number): Promise<void> {
  const tab = win.locator('.pane-tab').nth(index)
  await tab.hover()
  await tab.locator('.pane-tab-close').click()
}

test('closing a tab returns to the tab that opened it, else the most recently used one', async () => {
  test.setTimeout(180_000)
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(SITE)
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const siteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New browser tab' }).first().click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address').first()
    await expect(address).toBeVisible({ timeout: 15_000 })
    await expect(address).toBeFocused()
    await address.fill(siteUrl)
    await address.press('Enter')
    await expect(tabs(win)).toHaveCount(2, { timeout: 15_000 })
    await expect.poll(() => siteLoaded(app, siteUrl), { timeout: 15_000 }).toBe(true)

    await ctrlClick(app, siteUrl, 30)
    await expect(tabs(win)).toHaveCount(3, { timeout: 15_000 })
    await ctrlClick(app, siteUrl, 90)
    await expect(tabs(win)).toHaveCount(4, { timeout: 15_000 })
    await expect(tabs(win).nth(1)).toHaveAttribute('aria-selected', 'true')

    await tabs(win).nth(3).click()
    await expect(tabs(win).nth(3)).toHaveAttribute('aria-selected', 'true')
    await closeTab(win, 3)
    await expect(tabs(win)).toHaveCount(3)
    await expect(tabs(win).nth(1)).toHaveAttribute('aria-selected', 'true')

    await tabs(win).nth(2).click()
    await tabs(win).nth(0).click()
    await tabs(win).nth(2).click()
    await closeTab(win, 2)
    await expect(tabs(win)).toHaveCount(2)
    await expect(tabs(win).nth(0)).toHaveAttribute('aria-selected', 'true')
  } finally {
    await quitApp(app)
    server.close()
  }
})

test(`closing the tab that holds the keyboard moves it to the shown terminal`, async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    behavior: { gpuAcceleration: false },
    workspaces: { confirmQuit: false },
  })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, SHELL: '/bin/zsh' },
  })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await typeLine(win, 'export WHERE=first')
    await addTab(win)
    await expect(tabs(win)).toHaveCount(2)
    await win.keyboard.press(chords.closePane)
    await expect(tabs(win)).toHaveCount(1)
    await expect
      .poll(() =>
        win.evaluate(
          () => document.activeElement?.closest('.pane-slot:not([data-hidden])') !== null,
        ),
      )
      .toBe(true)
    const marker = join(dataHome, 'where')
    await typeLine(win, `echo $WHERE > ${marker}`)
    await expect.poll(() => existsSync(marker) && readFileSync(marker, 'utf8').trim()).toBe('first')
  } finally {
    await quitApp(app)
  }
})
