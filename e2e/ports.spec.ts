import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { holdPort } from '../test/heldPort'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { extensionHosts } from './extensionHosts'
import { openWorkspace, runInTerminal, shownTerminal } from './helpers'
import { _electron as electron, expect, test } from './test'

function launchIn(dataHome: string) {
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const launch = isolatedLaunch(dataHome)
  return electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
}

test('a port a terminal listens on shows in the top bar and opens in the browser pane', async () => {
  const dataHome = freshDataHome()
  const held = await holdPort()
  const { port } = held
  const app = await launchIn(dataHome)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await runInTerminal(win, `python3 -m http.server ${port} --bind 127.0.0.1`, shownTerminal(win))

    const chip = win
      .locator('.topbar-right .workspace-chips')
      .getByRole('button', { name: 'Listening ports: 1. Click to list them.' })
    await expect(chip).toBeVisible({ timeout: 20_000 })
    expect(extensionHosts(app)).toEqual([])
    await chip.click()
    const open = win.getByRole('button', {
      name: `Open http://localhost:${port}/ in the browser pane`,
    })
    await open.click()

    await expect(win.locator('.pane-tab .title').filter({ hasText: /./ })).toHaveCount(2, {
      timeout: 15_000,
    })
    await expect
      .poll(
        () =>
          app.evaluate(({ webContents }) =>
            webContents
              .getAllWebContents()
              .filter((wc) => wc.getType() === 'webview')
              .map((wc) => wc.getURL()),
          ),
        { timeout: 15_000 },
      )
      .toContain(`http://localhost:${port}/`)
    expect(extensionHosts(app)).toEqual([])

    await win.getByRole('tablist').getByRole('tab').first().click()
    await win.locator('.ghostty-host').first().click()
    await win.keyboard.press('Control+c')
    await expect(win.locator('.terminal-text').first()).toContainText('Keyboard interrupt', {
      timeout: 10_000,
    })
    await expect(chip).toHaveCount(0, { timeout: 20_000 })
  } finally {
    await app.close()
    held.release()
  }
})
