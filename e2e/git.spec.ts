import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('a dirty repo opens a diff from the Git panel and commits', async () => {
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

    const chips = win.locator('.topbar-right .workspace-chips .pane-chip')
    await chips.filter({ hasText: /^main$/ }).click({ timeout: 15_000 })

    const panelTitle = win.locator('.pane-header .title').filter({ hasText: /^Git$/ })
    await expect(panelTitle).toBeVisible({ timeout: 15_000 })
    const panel = win.locator('.git-surface')
    const row = panel.locator('button.change[data-path="notes.txt"]')
    await expect(row).toBeVisible({ timeout: 15_000 })

    await panel.evaluate((el) => {
      ;(el as HTMLElement).dataset.e2eMount = 'first'
    })
    await row.click()

    await expect(
      win.locator('.pane-header .title').filter({ hasText: 'notes.txt (unstaged)' }),
    ).toBeVisible({ timeout: 15_000 })
    const diff = win.locator('.diff-surface .monaco-diff-editor')
    await expect(diff).toBeVisible({ timeout: 15_000 })
    await expect(diff).toContainText('second line from e2e', { timeout: 15_000 })
    await expect(win.locator('.diff-title')).toHaveText(join(home, 'notes.txt'))
    await expect(panel).toHaveAttribute('data-e2e-mount', 'first')

    await panelTitle.click()
    await panel.getByRole('button', { name: 'Stage: notes.txt' }).click()
    await expect(panel.locator('section.area-staged')).toBeVisible({ timeout: 15_000 })
    await panel.locator('.commit textarea.message').fill('commit from e2e')
    await panel.locator('.commit button.primary').click()
    await expect(panel).toContainText('No changes', { timeout: 15_000 })
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: home })
    expect(subject.toString().trim()).toBe('commit from e2e')
  } finally {
    await app.close()
  }
})
