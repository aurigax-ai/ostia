import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'

test('a dirty repo shows in the sidebar and the top bar, opens a diff, commits, and shows the graph', async () => {
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

    await expect(
      win.locator('.rail-meta.location .ext-item').filter({ hasText: 'main' }),
    ).toContainText('main ~1', { timeout: 15_000 })

    const chips = win.locator('.topbar-right .workspace-chips .pane-chip')
    await expect(chips.filter({ hasText: '1 • +1' })).toBeVisible({ timeout: 15_000 })
    const branchChip = chips.filter({ hasText: /^main$/ })
    await expect(branchChip).toBeVisible()
    await branchChip.click()

    const panelTitle = win.locator('.pane-header .title').filter({ hasText: /^Git$/ })
    await expect(panelTitle).toBeVisible({ timeout: 15_000 })
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

    await guestEval(`document.querySelector('[aria-label="Stage: notes.txt"]').click(); 'ok'`)
    await expect
      .poll(() => guestEval('document.body.innerText'), { timeout: 15_000 })
      .toContain('STAGED')
    await guestEval(`(() => {
      const box = document.querySelector('textarea.message')
      box.value = 'commit from e2e'
      box.dispatchEvent(new Event('input'))
      document.querySelector('.commit button.primary').click()
      return 'ok'
    })()`)
    await expect
      .poll(() => guestEval('document.body.innerText'), { timeout: 15_000 })
      .toContain('No changes')
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: home })
    expect(subject.toString().trim()).toBe('commit from e2e')
    await expect(chips.filter({ hasText: '1 • +1' })).toHaveCount(0, { timeout: 15_000 })

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Show Graph')
    await waitForPaletteSelection(win, 'Show Graph')
    await win.keyboard.press('Enter')
    await expect
      .poll(() => guestEval('document.body.innerText'), { timeout: 15_000 })
      .toContain('commit from e2e')
    await expect(panelTitle).toHaveCount(1)
  } finally {
    await app.close()
  }
})
