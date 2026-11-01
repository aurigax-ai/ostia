import { isolatedLaunch } from './dataHome'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

test('ostia pane move --tab moves running panes into a split tab and back out', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const strip = win.getByRole('tablist')
    const tabs = strip.getByRole('tab')
    const caller = win.locator('.terminal-text').first()
    await win.locator('.ghostty-host').first().click()

    await typeLine(win, 'ostia process run "sleep 300" --name w1')
    await typeLine(win, 'ostia process run "sleep 300" --name w2')
    await expect(tabs).toHaveCount(3, { timeout: 15_000 })
    await expect(caller).toContainText('"name":"w2"', { timeout: 15_000 })

    await typeLine(win, 'clear; ostia pane move w1 w2 --tab workers')
    const pill = strip.locator('.pane-split-tab')
    await expect(pill).toHaveCount(1, { timeout: 15_000 })
    await expect(pill).toHaveAttribute('aria-label', /^Split tab workers, side by side: /)
    await expect(tabs).toHaveCount(2)

    await typeLine(win, 'clear; ostia pane move w2 --tab new')
    await expect(strip.locator('.pane-split-tab')).toHaveCount(0, { timeout: 15_000 })
    await expect(tabs).toHaveCount(3)
  } finally {
    await app.close()
  }
})
