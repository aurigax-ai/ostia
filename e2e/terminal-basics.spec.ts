import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

async function launch() {
  const app = await electron.launch(isolatedLaunch())
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const rows = win.locator('.xterm-rows').first()
  await openWorkspace(win)
  await win.locator('.xterm').first().click()
  return { app, win, rows }
}

test('Ctrl+K reaches the shell as readline kill-line', async () => {
  test.setTimeout(60_000)
  const { app, win, rows } = await launch()
  try {
    await win.keyboard.type('echo pine_kk')
    await win.keyboard.press('Control+a')
    await win.keyboard.press('Control+k')
    await win.keyboard.type('echo pine_$((20+22))_ok')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_42_ok', { timeout: 15_000 })
    await expect(rows).not.toContainText('pine_kk')
    await expect(win.getByRole('dialog')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('Ctrl+Shift+P opens the command palette from a focused terminal', async () => {
  const { app, win } = await launch()
  try {
    await win.keyboard.press('Control+Shift+P')
    await expect(win.getByRole('dialog')).toBeVisible({ timeout: 5_000 })
  } finally {
    await app.close()
  }
})

test('Ctrl+Shift+F opens the find bar and Escape closes it', async () => {
  test.setTimeout(60_000)
  const { app, win, rows } = await launch()
  try {
    await win.keyboard.type('echo pine_find_target')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_find_target', { timeout: 15_000 })

    await win.keyboard.press('Control+Shift+F')
    const input = win.getByLabel('Find in terminal')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await expect(input).toBeFocused()
    await input.fill('pine_find_target')
    await expect(win.locator('.term-find-count')).toHaveText(/\d+\/\d+|\d+/, { timeout: 5_000 })

    await input.press('Escape')
    await expect(input).toHaveCount(0)
  } finally {
    await app.close()
  }
})
