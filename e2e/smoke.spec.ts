import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { emptyState, openSession } from './helpers'

test('boots and renders the main window', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    expect(await win.title()).toBeTruthy()
    await expect(win.locator('.deck-rail')).toBeVisible({ timeout: 15_000 })
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await openSession(win)
  } finally {
    await app.close()
  }
})
