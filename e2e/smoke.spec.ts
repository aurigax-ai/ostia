import { isolatedLaunch } from './dataHome'
import { emptyState, openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('boots and renders the main window', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    expect(await win.title()).toBeTruthy()
    await expect(win.locator('.deck-rail')).toBeVisible({ timeout: 15_000 })
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await openWorkspace(win)
  } finally {
    await app.close()
  }
})
