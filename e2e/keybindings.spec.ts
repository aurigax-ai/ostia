import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

async function openKeyboardSettings(win: Page) {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Keyboard' }).click()
  return settings
}

function paletteRow(win: Page) {
  return win
    .getByRole('region', { name: 'Keyboard' })
    .getByRole('row')
    .filter({ hasText: 'palette.toggle' })
}

async function closeSettings(win: Page) {
  await win.keyboard.press('Escape')
  await expect(win.getByRole('region', { name: 'Settings' })).toHaveCount(0)
}

async function focusTerminal(win: Page) {
  await win.locator('.xterm').first().click()
  await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
}

const palette = (win: Page) => win.getByRole('dialog', { name: 'Command palette' })

test('a rebound palette chord works from a focused terminal, refuses Ctrl+R, and resets', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await openKeyboardSettings(win)
    await expect(paletteRow(win)).toContainText('Ctrl+Shift+P')
    await win.getByRole('button', { name: 'Record a shortcut for Command Palette' }).click()
    await win.keyboard.press('Control+Shift+Y')
    await expect(paletteRow(win)).toContainText('Ctrl+Shift+Y')

    await win.getByRole('button', { name: 'Record a shortcut for Command Palette' }).click()
    await win.keyboard.press('Control+r')
    await expect(paletteRow(win).getByRole('alert')).toContainText(
      'Ctrl+R can’t be used: plain Ctrl keys belong to the shell',
    )
    await win.keyboard.press('Escape')
    await expect(paletteRow(win)).toContainText('Ctrl+Shift+Y')
    await closeSettings(win)

    await focusTerminal(win)
    await win.keyboard.press('Control+Shift+P')
    await win.waitForTimeout(400)
    await expect(palette(win)).toHaveCount(0)
    await win.keyboard.press('Control+Shift+Y')
    await expect(palette(win)).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(palette(win)).toHaveCount(0)

    await openKeyboardSettings(win)
    await win.getByRole('button', { name: 'Reset Command Palette' }).click()
    await expect(paletteRow(win)).toContainText('Ctrl+Shift+P')
    await closeSettings(win)

    await focusTerminal(win)
    await win.keyboard.press('Control+Shift+Y')
    await win.waitForTimeout(400)
    await expect(palette(win)).toHaveCount(0)
    await win.keyboard.press('Control+Shift+P')
    await expect(palette(win)).toBeVisible()
  } finally {
    await app.close()
  }
})
