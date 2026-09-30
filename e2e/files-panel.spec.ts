import { basename } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { PROMPT, emptyWorkspace, openWorkspace } from './helpers'

test('the Files panel opens beside the workspace list and follows the active workspace', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await win.keyboard.type('cd /tmp')
    await win.keyboard.press('Enter')

    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    const panel = win.locator('.files-panel')
    const current = panel.locator('.crumb.current')
    await expect(panel).toBeVisible()
    await expect(win.locator('.deck-rail .rail-tab')).toHaveCount(1)
    await expect(current).toHaveText('tmp', { timeout: 15_000 })

    await win.locator('.topbar').getByRole('button', { name: 'New workspace' }).click()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows').first()).toContainText(
      PROMPT,
      { timeout: 15_000 },
    )
    const home = await app.evaluate(({ app: electronApp }) => electronApp.getPath('home'))
    await expect(current).toHaveText(basename(home))

    await win.locator('.deck-rail .rail-tab-main').first().click()
    await expect(current).toHaveText('tmp')

    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await expect(panel).toHaveCount(0)
  } finally {
    await app.close()
  }
})
