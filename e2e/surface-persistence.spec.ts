import { _electron as electron, expect, test } from './test'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

test('splitting keeps the original terminal DOM node and its history', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    await openWorkspace(win)
    const firstRows = win.locator('.xterm-rows').first()

    await win.locator('.xterm').first().click()
    await win.keyboard.type('echo survivor_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(firstRows).toContainText('survivor_42')

    await win.evaluate(() => {
      document.querySelector('.xterm')?.setAttribute('data-e2e-survivor', '1')
    })

    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })

    await win.locator('.pane.active').getByRole('button', { name: 'Split down' }).click()
    await expect(win.locator('.xterm')).toHaveCount(3, { timeout: 15_000 })

    const survivor = win.locator('.pane .xterm[data-e2e-survivor="1"]')
    await expect(survivor).toHaveCount(1)
    await expect(survivor).toBeVisible()
    await expect(survivor.locator('.xterm-rows')).toContainText('survivor_42')
    const box = await survivor.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(50)
    expect(box?.height ?? 0).toBeGreaterThan(50)
  } finally {
    await app.close()
  }
})
