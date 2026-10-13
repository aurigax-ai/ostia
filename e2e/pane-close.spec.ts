import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

test(
  'an agent closes a worker tab it started with ostia pane close <name>',
  { tag: '@core' },
  async () => {
    const dataHome = freshDataHome()
    const bin = fakeAgentBin(dataHome)
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({
      ...launch,
      env: { ...launch.env, HOME: isolatedHome(dataHome), PATH: `${bin}:${launch.env.PATH ?? ''}` },
    })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      const coordinator = win.locator('.xterm-rows').first()
      await win.locator('.xterm').first().click()
      const tabs = win.locator('.pane-tab')

      await typeLine(win, 'ostia agent run claude "fix the login bug" --name fixer')
      await expect(tabs).toHaveCount(2)
      await expect(win.locator('.xterm-rows').nth(1)).toContainText('fake-agent-ready', {
        timeout: 15_000,
      })

      await typeLine(win, 'ostia pane close nobody; echo unknown-exit-$?')
      await expect(coordinator).toContainText('unknown-pane: nobody')
      await expect(coordinator).toContainText('unknown-exit-1')

      await typeLine(win, 'ostia pane close fixer && echo close-ok')
      await expect(coordinator).toContainText('close-ok', { timeout: 15_000 })
      await expect(tabs).toHaveCount(1)
      await expect(win.getByRole('region', { name: 'Agent permission request' })).toHaveCount(0)
      await expect(win.getByRole('alertdialog')).toHaveCount(0)
    } finally {
      await app.close()
    }
  },
)
