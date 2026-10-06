import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { emptyWorkspace, openWorkspace } from './helpers'

test('a diff pane is hidden with its workspace and behind Settings', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const vcs = (...args: string[]): void => {
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: home })
  }
  vcs('init', '-q', '-b', 'main')
  vcs('config', 'user.email', 'e2e@example.com')
  vcs('config', 'user.name', 'E2E')
  writeFileSync(join(home, 'notes.txt'), 'first line\n')
  writeFileSync(join(home, '.gitignore'), '*\n!notes.txt\n!.gitignore\n')
  vcs('add', 'notes.txt', '.gitignore')
  vcs('commit', '-q', '-m', 'init')
  writeFileSync(join(home, 'notes.txt'), 'first line\nsecond line from e2e\n')

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    const branchChip = win
      .locator('.topbar-right .workspace-chips .pane-chip')
      .filter({ hasText: /^main$/ })
    await expect(branchChip).toBeVisible({ timeout: 15_000 })
    await branchChip.click()
    await expect(win.locator('.pane-header .title').filter({ hasText: /^Git$/ })).toBeVisible({
      timeout: 15_000,
    })
    const guestEval = (script: string): Promise<string> =>
      app.evaluate(async ({ webContents }, code) => {
        const guest = webContents
          .getAllWebContents()
          .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
        return guest ? String(await guest.executeJavaScript(code)) : ''
      }, script)
    await expect
      .poll(() => guestEval('document.body.innerText'), { timeout: 15_000 })
      .toContain('notes.txt')
    await guestEval(`document.querySelector('button.change[data-path="notes.txt"]').click(); 'ok'`)

    const sides = win.locator('.diff-surface .monaco-diff-editor .editor')
    await expect(sides).toHaveCount(2, { timeout: 15_000 })
    await expect(sides.first()).toBeVisible()
    await expect(sides.last()).toBeVisible()
    await expect(sides.last()).toContainText('second line from e2e', { timeout: 15_000 })

    await win.keyboard.press('Control+,')
    await expect(win.getByRole('region', { name: 'Settings' })).toBeVisible({ timeout: 10_000 })
    await expect(sides.first()).toBeHidden()
    await expect(sides.last()).toBeHidden()
    await win.keyboard.press('Escape')
    await expect(sides.last()).toBeVisible()

    await win.keyboard.press('Control+Shift+N')
    await expect(win.locator('.rail-row')).toHaveCount(2, { timeout: 10_000 })
    await expect(emptyWorkspace(win)).toBeVisible()
    await expect(sides.first()).toBeHidden()
    await expect(sides.last()).toBeHidden()

    await win.locator('.rail-row').first().click()
    await expect(sides.last()).toBeVisible()
  } finally {
    await app.close()
  }
})
