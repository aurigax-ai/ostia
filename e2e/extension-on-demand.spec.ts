import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { extensionHosts } from './extensionHosts'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

function dirtyRepoHome(dataHome: string): string {
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
  writeFileSync(join(home, 'notes.txt'), 'first line\nsecond line\n')
  return home
}

test('no extension host runs for the branch, the diff stats or the Git panel, also when the panel is restored', async () => {
  const dataHome = freshDataHome()
  const home = dirtyRepoHome(dataHome)
  const launch = isolatedLaunch(dataHome)
  const env = { ...launch.env, HOME: home }
  let app = await electron.launch({ ...launch, env })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await expect(
      win.locator('.rail-meta.location .ext-item').filter({ hasText: 'main' }),
    ).toHaveText('main', { timeout: 15_000 })
    const chips = win.locator('.topbar-right .workspace-chips .pane-chip')
    await expect(chips.filter({ hasText: '1 • +1' })).toBeVisible({ timeout: 15_000 })
    await win.waitForTimeout(1000)
    expect(extensionHosts(app)).toEqual([])

    await chips.filter({ hasText: /^main$/ }).click()
    await expect(win.locator('.pane-header .title').filter({ hasText: /^Git$/ })).toBeVisible({
      timeout: 15_000,
    })
    await expect(win.locator('.git-surface button.change[data-path="notes.txt"]')).toBeVisible({
      timeout: 15_000,
    })
    expect(extensionHosts(app)).toEqual([])
  } finally {
    await app.close()
  }

  app = await electron.launch({ ...launch, env })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.pane-header .title').filter({ hasText: /^Git$/ })).toBeVisible({
      timeout: 15_000,
    })
    await expect(win.locator('.git-surface button.change[data-path="notes.txt"]')).toBeVisible({
      timeout: 15_000,
    })
    expect(extensionHosts(app)).toEqual([])
  } finally {
    await app.close()
  }
})
