import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('right-click in a terminal offers copy, paste, select all and clear', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()
    await win.keyboard.type('echo ostia_menu_marker')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_menu_marker', { timeout: 15_000 })

    await win.locator('.xterm').first().click({ button: 'right' })
    await expect(win.getByRole('menuitem', { name: 'Paste' })).toBeVisible()
    await expect(win.getByRole('menuitem', { name: 'Select All' })).toBeVisible()
    await win.getByRole('menuitem', { name: 'Clear Terminal' }).click()
    await expect(rows).not.toContainText('ostia_menu_marker', { timeout: 15_000 })
    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()

    await win.keyboard.type('echo ostia_after_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_after_42', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
