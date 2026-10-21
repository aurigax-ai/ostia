import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, restartApp } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

function frames(win: Page): Promise<void> {
  return win.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

test('a tab renamed by double-click keeps its name across a restart', async () => {
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
    await frames(win)
    await expect(input).toBeFocused()
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
    await expect(win.locator('.pane-tab .title').first()).toHaveText('builder', {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})
