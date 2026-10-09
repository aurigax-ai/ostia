import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

async function launch() {
  const app = await electron.launch(isolatedLaunch())
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

async function openSettings(win: Page, section: string) {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: section }).click()
  return settings
}

test('a multi-line paste asks first; Cancel pastes nothing, Enter pastes, and Don’t ask again turns it off', async () => {
  const { app, win } = await launch()
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('echo ostiacancelled\necho two\n'))
    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+Shift+V')

    const dialog = win.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('It has 2 lines')
    await expect(dialog.getByLabel('Text to paste')).toContainText('echo ostiacancelled')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await win.waitForTimeout(500)
    await expect(win.locator('.xterm-rows').first()).not.toContainText('ostiacancelled')

    await app.evaluate(({ clipboard }) =>
      clipboard.writeText('echo ostiafirst\necho ostiapasted42'),
    )
    await win.keyboard.press('Control+Shift+V')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Paste' })).toBeFocused()
    await win.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await win.keyboard.press('Enter')
    await expect(
      win.locator('.xterm-rows div', { hasText: /^ostiapasted42\s*$/ }).first(),
    ).toBeAttached({ timeout: 15_000 })

    await app.evaluate(({ clipboard }) => clipboard.writeText('echo a\necho b'))
    await win.keyboard.press('Control+Shift+V')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('checkbox', { name: /Don’t ask again/ }).click()
    await dialog.getByRole('button', { name: 'Paste' }).click()
    await expect(dialog).toHaveCount(0)
    const settings = await openSettings(win, 'Terminal')
    await expect(
      settings.getByRole('switch', { name: 'Confirm multi-line paste' }),
    ).not.toBeChecked()
  } finally {
    await app.close()
  }
})
