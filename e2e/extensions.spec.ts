import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'

test('the kanban extension panel opens from the palette and shows a card added with pine kanban', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.xterm-rows').first()).toContainText(/[❯$%#]/, { timeout: 15_000 })

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Open Board')
    await expect(win.getByRole('dialog').getByText('Open Board', { exact: true })).toBeVisible()
    await win.keyboard.press('Enter')

    await expect(win.locator('.pane-header .title').filter({ hasText: 'Board' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(win.locator('webview.extension-webview')).toHaveCount(1, { timeout: 15_000 })

    const panelText = (): Promise<string> =>
      app.evaluate(async ({ webContents }) => {
        const guest = webContents
          .getAllWebContents()
          .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
        return guest ? String(await guest.executeJavaScript('document.body.innerText')) : ''
      })
    await expect.poll(panelText, { timeout: 15_000 }).toContain('Todo')

    await win.locator('.xterm').first().click()
    await win.keyboard.type('pine kanban add "e2e extension card"')
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows').first()).toContainText('card-1', { timeout: 15_000 })

    await expect.poll(panelText, { timeout: 15_000 }).toContain('e2e extension card')
  } finally {
    await app.close()
  }
})
