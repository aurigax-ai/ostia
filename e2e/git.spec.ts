import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { addTab, openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('a dirty repo shows Changes in the side panel, opens a diff as a pane and commits', async () => {
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
    await chips.filter({ hasText: /^main · \+1$/ }).click({ timeout: 15_000 })

    const dock = win.locator('#right-panel')
    await expect(dock).toHaveAttribute('aria-label', 'Git', { timeout: 15_000 })
    await expect(dock).not.toHaveAttribute('data-hidden')
    const panel = win.locator('.git-surface')
    const row = panel.locator('button.change[data-path="notes.txt"]')
    await expect(row).toBeVisible({ timeout: 15_000 })

    await panel.evaluate((el) => {
      ;(el as HTMLElement).dataset.e2eMount = 'first'
    })
    await row.click()

    await expect(
      win.locator('.pane-header .title').filter({ hasText: 'notes.txt (Working Tree)' }),
    ).toBeVisible({ timeout: 15_000 })
    const diff = win.locator('.diff-surface .monaco-diff-editor')
    await expect(diff).toBeVisible({ timeout: 15_000 })
    await expect(diff).toContainText('second line from e2e', { timeout: 15_000 })
    await expect(win.locator('.diff-surface').getByText(join(home, 'notes.txt'))).toHaveCount(0)
    await expect(panel).toHaveAttribute('data-e2e-mount', 'first')

    await win.getByRole('button', { name: 'Inline view' }).click()
    await expect(win.locator('.diff-surface .monaco-diff-editor.side-by-side')).toHaveCount(0)
    await expect
      .poll(() =>
        readFileSync(join(dataHome, 'userData', 'settings.json'), 'utf8').includes(
          '"diffLayout": "inline"',
        ),
      )
      .toBe(true)

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

test('the top bar has one git entry, a button-sized chip that follows the shown tab', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const vcs = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd })
  }
  vcs(home, 'init', '-q', '-b', 'main')
  vcs(home, 'config', 'user.email', 'e2e@example.com')
  vcs(home, 'config', 'user.name', 'E2E')
  writeFileSync(join(home, '.gitignore'), '*\n!notes.txt\n!.gitignore\n')
  writeFileSync(join(home, 'notes.txt'), 'one\n')
  vcs(home, 'add', '.')
  vcs(home, 'commit', '-q', '-m', 'init')
  const tree = join(dataHome, 'tree')
  vcs(home, 'worktree', 'add', '-q', '-b', 'feature/tree', tree)
  writeFileSync(join(tree, 'notes.txt'), 'one\ntwo\nthree\n')

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    const chip = win.locator('.topbar-right .workspace-chips .pane-chip')
    await expect(chip).toHaveText('main', { timeout: 15_000 })
    await expect(win.locator('.topbar-left').getByRole('button', { name: 'Git' })).toHaveCount(0)
    const box = await chip.boundingBox()
    expect(box?.height).toBe(24)

    await addTab(win)
    const tabs = win.getByRole('tablist').getByRole('tab')
    await expect(tabs).toHaveCount(2, { timeout: 15_000 })
    await win.locator('.xterm:visible').click()
    await win.keyboard.type(`cd ${tree}`)
    await win.keyboard.press('Enter')
    await expect(chip).toHaveText('feature/tree · +2', { timeout: 15_000 })

    await tabs.nth(0).click()
    await expect(chip).toHaveText('main', { timeout: 5_000 })
  } finally {
    await app.close()
  }
})

test('a long branch name truncates with an ellipsis and the upstream yields instead of overlapping it', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const remote = join(dataHome, 'remote.git')
  mkdirSync(home, { recursive: true })
  mkdirSync(remote, { recursive: true })
  const vcs = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd })
  }
  const branch = 'feature/a-branch-name-too-long-for-the-side-panel-header'
  vcs(remote, 'init', '-q', '--bare')
  vcs(home, 'init', '-q', '-b', branch)
  vcs(home, 'config', 'user.email', 'e2e@example.com')
  vcs(home, 'config', 'user.name', 'E2E')
  writeFileSync(join(home, 'notes.txt'), 'one\n')
  vcs(home, 'add', 'notes.txt')
  vcs(home, 'commit', '-q', '-m', 'init')
  vcs(home, 'remote', 'add', 'origin', remote)
  vcs(home, 'push', '-q', '-u', 'origin', branch)
  writeFileSync(join(home, 'notes.txt'), 'one\ntwo\n')
  vcs(home, 'commit', '-q', '-a', '-m', 'ahead')

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win
      .locator('.topbar-right .workspace-chips .pane-chip')
      .filter({ hasText: 'feature/' })
      .click({ timeout: 15_000 })
    const head = win.locator('.git-surface .head')
    await expect(head.locator('.tracking .upstream-name')).toBeVisible({ timeout: 15_000 })

    const name = head.locator('.branch-name')
    const tracking = head.locator('.tracking')
    const panel = await win.locator('#right-panel').boundingBox()
    const nameBox = await name.boundingBox()
    const trackingBox = await tracking.boundingBox()
    expect(panel && nameBox && trackingBox).toBeTruthy()
    if (!panel || !nameBox || !trackingBox) return
    expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(panel.x + panel.width)
    const sameRow = Math.abs(nameBox.y - trackingBox.y) < nameBox.height
    if (sameRow) expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(trackingBox.x + 1)
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis')
  } finally {
    await app.close()
  }
})
