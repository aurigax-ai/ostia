import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

test('a terminal notification in a background pane raises attention and Ctrl+Shift+U jumps to it', async () => {
  test.setTimeout(90_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    const panes = win.locator('.pane')
    await expect(panes).toHaveCount(2)
    const first = panes.nth(0)
    const second = panes.nth(1)
    await expect(second.locator('.xterm-rows')).toContainText(/[❯$%#]/, { timeout: 15_000 })

    await first.locator('.xterm').click()
    await expect(first).toHaveClass(/\bactive\b/)
    await win.keyboard.type("sleep 3; printf '\\e]9;build finished\\a'")
    await win.keyboard.press('Enter')
    await second.locator('.xterm').click()
    await expect(second).toHaveClass(/\bactive\b/)

    await expect(first).toHaveClass(/\battn-ring\b/, { timeout: 15_000 })
    await expect(first.locator('.pane-attn-msg')).toHaveText('build finished')
    await expect(second).not.toHaveClass(/\battn-ring\b/)
    await expect(win.getByRole('img', { name: '1 unread' })).toBeVisible()
    await expect(win.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible()

    await win.keyboard.press('Control+Shift+U')

    await expect(first).toHaveClass(/\bactive\b/)
    await expect(first).not.toHaveClass(/\battn-ring\b/)
    await expect(win.getByRole('img', { name: '1 unread' })).toHaveCount(0)
    await expect
      .poll(() =>
        win.evaluate(() =>
          Boolean(
            document.activeElement?.classList.contains('xterm-helper-textarea') &&
              document.activeElement.closest('.pane') === document.querySelectorAll('.pane')[0],
          ),
        ),
      )
      .toBe(true)

    const bell = win.getByRole('button', { name: 'Notifications' })
    await expect(bell).toBeVisible()
    await bell.click()
    const list = win.getByRole('list', { name: 'Notifications' })
    await expect(list.getByRole('button').first()).toContainText('build finished')
  } finally {
    await app.close()
  }
})
