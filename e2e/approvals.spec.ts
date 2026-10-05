import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

test('an agent call that lacks a capability waits for the human and continues once allowed', async () => {
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    const terminal = win.locator('.xterm').first()
    await terminal.click()
    await win.keyboard.type('ostia settings set sidebar.showSSH false && echo APPROVED-RUN')
    await win.keyboard.press('Enter')

    const card = win.getByRole('region', { name: 'Agent permission request' })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('change settings')
    await card.getByRole('button', { name: 'Allow once' }).click()
    await expect(card).toHaveCount(0)
    await expect(win.locator('.xterm-rows')).toContainText('APPROVED-RUN', { timeout: 15_000 })

    await terminal.click()
    await win.keyboard.type('ostia settings set sidebar.showSSH true || echo REFUSED-RUN')
    await win.keyboard.press('Enter')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: 'Deny' }).click()
    await expect(win.locator('.xterm-rows')).toContainText('denied: settings-write', {
      timeout: 15_000,
    })
    await expect(win.locator('.xterm-rows')).toContainText('REFUSED-RUN')

    await win.getByRole('button', { name: /Notifications/ }).click()
    const inbox = win.getByRole('region', { name: 'Permission requests' })
    await expect(inbox).toContainText('Allowed once')
    await expect(inbox).toContainText('Denied')
  } finally {
    await app.close()
  }
})
