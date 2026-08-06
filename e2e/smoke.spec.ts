import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'

/**
 * Boot smoke: the built app launches, opens a window, and renders. This is the E2E
 * feasibility floor — if this passes, the real workflow specs (spawn terminal, split
 * pane, open editor, command palette) can follow.
 */
test('boots and renders the main window', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    expect(await win.title()).toBeTruthy()
    // A title alone doesn't prove the renderer mounted — assert real landmarks: the
    // sidebar chrome and a live terminal surface.
    await expect(win.locator('.deck-rail')).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})
