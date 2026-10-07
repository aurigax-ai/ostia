import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

test('always allow saves the grant, stops asking, and Remove in Settings asks again', async () => {
  const dataHome = freshDataHome()
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const terminal = win.locator('.xterm').first()
    const run = async (line: string): Promise<void> => {
      await terminal.click()
      await win.keyboard.type(line)
      await win.keyboard.press('Enter')
    }
    const card = win.getByRole('region', { name: 'Agent permission request' })

    await run('ostia settings set sidebar.showSSH false && echo FIRST-RUN')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: 'More ways to allow' }).click()
    await win.getByRole('menuitem', { name: 'Always allow' }).click()
    await expect(card).toHaveCount(0)
    await expect(win.locator('.xterm-rows')).toContainText('FIRST-RUN', { timeout: 15_000 })
    const saved = JSON.parse(readFileSync(join(dataHome, 'userData', 'settings.json'), 'utf8'))
    expect(saved.capabilities.grants).toEqual(['settings-write'])

    await run('ostia settings set sidebar.showSSH true && echo SECOND-RUN')
    await expect(win.locator('.xterm-rows')).toContainText('SECOND-RUN', { timeout: 15_000 })
    await expect(card).toHaveCount(0)

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Agents' }).click()
    const always = settings.locator('section', {
      has: win.getByRole('heading', { name: 'Always allowed' }),
    })
    await always.getByRole('button', { name: 'Remove' }).click()
    await expect(always).toContainText('Nothing is always allowed')

    await win.keyboard.press('Escape')
    await expect(terminal).toBeVisible()
    await run('ostia settings set sidebar.showSSH false || echo THIRD-REFUSED')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: 'Deny' }).click()
    await expect(win.locator('.xterm-rows')).toContainText('THIRD-REFUSED', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
