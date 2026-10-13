import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, restartApp } from './helpers'
import { _electron as electron, expect, test } from './test'

test('a tab is renamed by double-click, the name survives a restart, and Escape in the menu rename keeps it', async () => {
  const dataHome = freshDataHome()
  let app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const main = win.locator('.pane-tab .pane-tab-main').first()

    await main.dblclick()
    const input = win.getByRole('textbox', { name: 'Rename Tab…' })
    await expect(input).toBeVisible()
    await input.fill('builder')
    await input.press('Enter')
    await expect(input).toHaveCount(0)
    await expect(win.locator('.pane-tab .title').first()).toHaveText('builder')

    await restartApp(app, win)
  } finally {
    await app.close().catch(() => {})
  }

  app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const title = win.locator('.pane-tab .title').first()
    await expect(title).toHaveText('builder', { timeout: 15_000 })

    await win.locator('.pane-tab').first().click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Rename Tab…' }).click()
    const input = win.getByRole('textbox', { name: 'Rename Tab…' })
    await input.fill('discarded')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(title).toHaveText('builder')
  } finally {
    await app.close()
  }
})
