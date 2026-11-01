import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('a streaming neighbour pane still receives all its output while the other pane is active and typed in', async () => {
  test.setTimeout(90_000)
  const launch = isolatedLaunch(freshDataHome())
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.ghostty-host').first().click()
    await win.keyboard.type('seq 1 60000; echo NEIGHBOUR-DONE')
    await win.keyboard.press('Enter')
    await win.keyboard.press(chords.splitRight)
    await expect(win.locator('.ghostty-host')).toHaveCount(2, { timeout: 15_000 })
    await win.keyboard.type('echo typed-in-active')
    await win.keyboard.press('Enter')
    const panes = win.locator('.pane[data-pane-id]')
    await expect(panes.nth(1).locator('.terminal-text')).toContainText('typed-in-active', {
      timeout: 15_000,
    })
    await expect(panes.nth(0).locator('.terminal-text')).toContainText('NEIGHBOUR-DONE', {
      timeout: 30_000,
    })
  } finally {
    await app.close()
  }
})
