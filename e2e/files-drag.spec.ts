import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from './test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

test('dragging a file from the Files panel types its quoted path at the terminal prompt', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'notes file.md'), '# notes\n')
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await expect(win.locator('.xterm-rows')).toContainText(/[❯$%#]/, { timeout: 15_000 })
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()

    await win
      .locator('.file-row')
      .filter({ hasText: 'notes file.md' })
      .dragTo(win.locator('.terminal-surface').first())

    await expect(win.locator('.xterm-rows')).toContainText(`'${join(home, 'notes file.md')}'`, {
      timeout: 10_000,
    })
  } finally {
    await app.close()
  }
})
