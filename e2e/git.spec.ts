import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'

test('a dirty repo shows in the sidebar, lists its changes, and opens a diff', async () => {
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
  vcs('add', 'notes.txt')
  vcs('commit', '-q', '-m', 'init')
  writeFileSync(join(home, 'notes.txt'), 'first line\nsecond line from e2e\n')

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.xterm-rows').first()).toContainText(/[❯$%#]/, { timeout: 15_000 })

    await expect(win.locator('.ext-item').filter({ hasText: 'main' })).toContainText('main ~1', {
      timeout: 15_000,
    })

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Show Changes')
    await expect(win.getByRole('dialog').getByText('Show Changes', { exact: true })).toBeVisible()
    await win.keyboard.press('Enter')

    await expect(win.locator('.pane-header .title').filter({ hasText: 'Changes' })).toBeVisible({
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

    await expect(
      win.locator('.pane-header .title').filter({ hasText: 'notes.txt (unstaged)' }),
    ).toBeVisible({ timeout: 15_000 })
    const diff = win.locator('.diff-surface .monaco-diff-editor')
    await expect(diff).toBeVisible({ timeout: 15_000 })
    await expect(diff).toContainText('second line from e2e', { timeout: 15_000 })
    await expect(win.locator('.diff-title')).toHaveText(join(home, 'notes.txt'))
  } finally {
    await app.close()
  }
})
