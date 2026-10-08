import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { extensionHosts } from './extensionHosts'
import { emptyState, emptyWorkspace, openWorkspace, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, test } from './test'

test('a dirty repo shows in the sidebar and the top bar, opens a diff, commits, and shows the graph, with no extension host', async () => {
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
    ).toHaveText('main', { timeout: 15_000 })

    const chips = win.locator('.topbar-right .workspace-chips .pane-chip')
    await expect(chips.filter({ hasText: '1 • +1' })).toBeVisible({ timeout: 15_000 })
    const branchChip = chips.filter({ hasText: /^main$/ })
    await expect(branchChip).toBeVisible()
    await branchChip.click()

    const panelTitle = win.locator('.pane-header .title').filter({ hasText: /^Git$/ })
    await expect(panelTitle).toBeVisible({ timeout: 15_000 })
    const panel = win.locator('.git-surface')
    await expect(panel).toHaveAttribute('data-page', 'changes')
    const row = panel.locator('button.change[data-path="notes.txt"]')
    await expect(row).toBeVisible({ timeout: 15_000 })

    await panel.evaluate((el) => {
      ;(el as HTMLElement).dataset.e2eMount = 'first'
    })
    const message = panel.locator('.commit textarea.message')
    await message.fill('draft kept')
    await row.click()

    await expect(
      win.locator('.pane-header .title').filter({ hasText: 'notes.txt (unstaged)' }),
    ).toBeVisible({ timeout: 15_000 })
    const diff = win.locator('.diff-surface .monaco-diff-editor')
    await expect(diff).toBeVisible({ timeout: 15_000 })
    await expect(diff).toContainText('second line from e2e', { timeout: 15_000 })
    await expect(win.locator('.diff-title')).toHaveText(join(home, 'notes.txt'))
    await expect(panel).toHaveAttribute('data-e2e-mount', 'first')
    await expect(message).toHaveValue('draft kept')

    await panelTitle.click()
    await panel.getByRole('button', { name: 'Stage: notes.txt' }).click()
    await expect(panel.locator('section.area-staged')).toBeVisible({ timeout: 15_000 })
    await message.fill('commit from e2e')
    await panel.locator('.commit button.primary').click()
    await expect(panel).toContainText('No changes', { timeout: 15_000 })
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: home })
    expect(subject.toString().trim()).toBe('commit from e2e')
    await expect(chips.filter({ hasText: '1 • +1' })).toHaveCount(0, { timeout: 15_000 })

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Show Graph')
    await waitForPaletteSelection(win, 'Show Graph')
    await win.keyboard.press('Enter')
    await expect(panel).toHaveAttribute('data-page', 'graph', { timeout: 15_000 })
    await expect(panel.locator('.graph-row').filter({ hasText: 'commit from e2e' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(panelTitle).toHaveCount(1)
    expect(extensionHosts(app)).toEqual([])
  } finally {
    await app.close()
  }
})

test('the branch chip shows for a workspace in a repo that has no panes yet', async () => {
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

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await emptyState(win)
      .getByRole('button', { name: /New workspace/ })
      .click()
    await expect(emptyWorkspace(win)).toBeVisible()

    const branchChip = win
      .locator('.topbar-right .workspace-chips .pane-chip')
      .filter({ hasText: /^main$/ })
    await expect(branchChip).toBeVisible({ timeout: 15_000 })

    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })
    await expect(branchChip).toBeVisible()
  } finally {
    await app.close()
  }
})
