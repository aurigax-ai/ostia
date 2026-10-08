import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, test } from './test'

function makeRepo(home: string): void {
  let clock = Math.floor(Date.now() / 1000) - 3600
  const vcs = (...args: string[]): void => {
    clock += 60
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: home,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `@${clock} +0000`,
        GIT_COMMITTER_DATE: `@${clock} +0000`,
      },
    })
  }
  const write = (path: string, text: string): void => {
    mkdirSync(join(home, path, '..'), { recursive: true })
    writeFileSync(join(home, path), text)
  }
  vcs('init', '-q', '-b', 'main')
  vcs('config', 'user.email', 'e2e@example.com')
  vcs('config', 'user.name', 'E2E')
  write('.gitignore', '*\n!.gitignore\n!notes.txt\n!src/\n!src/**\n')
  write('notes.txt', 'one\n')
  vcs('add', '.gitignore', 'notes.txt')
  vcs('commit', '-q', '-m', 'root commit')
  vcs('checkout', '-q', '-b', 'feature')
  write('src/deep/feature.txt', 'feature\n')
  vcs('add', 'src')
  vcs('commit', '-q', '-m', 'feature work')
  vcs('checkout', '-q', 'main')
  write('notes.txt', 'one\ntwo\n')
  vcs('commit', '-q', '-am', 'main work')
  vcs('merge', '-q', '--no-ff', '-m', 'merge feature into main', 'feature')
  vcs('checkout', '-q', '-b', 'side', 'HEAD~2')
  write('notes.txt', 'side\n')
  vcs('commit', '-q', '-am', 'side only work')
  vcs('checkout', '-q', 'main')
  write('src/deep/feature.txt', 'feature\nedited\n')
  write('src/deep/new.txt', 'new\n')
  vcs('add', 'src/deep/new.txt')
}

test('the graph shows the uncommitted row, switches to all branches, and changes follow the tree view setting', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  makeRepo(home)

  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const panel = win.locator('.git-surface')
    const showGraph = async (): Promise<void> => {
      await win.keyboard.press('Control+Shift+P')
      await win.locator('[data-slot="command-input"]').fill('Show Graph')
      await waitForPaletteSelection(win, 'Show Graph')
      await win.keyboard.press('Enter')
      await expect(
        panel.locator('.graph-row').filter({ hasText: 'merge feature into main' }),
      ).toBeVisible({ timeout: 15_000 })
    }

    await expect(
      win.locator('.topbar-right .workspace-chips .pane-chip').filter({ hasText: /^main$/ }),
    ).toBeVisible({
      timeout: 15_000,
    })
    await showGraph()

    const worktreeRow = panel.locator('.graph-row.worktree')
    await expect(worktreeRow).toContainText(/Uncommitted changes[\s\S]*1 staged[\s\S]*1 unstaged/)
    await expect(worktreeRow.locator('.node.pending')).toHaveCount(1)
    expect(await panel.locator('.edge.pending').count()).toBeGreaterThan(0)
    await expect(panel).not.toContainText('side only work')
    const scope = panel.locator('.scope-trigger')
    await expect(scope).toHaveText('Current branch')

    await worktreeRow.click()
    const detail = panel.locator('.detail')
    await expect(detail).toContainText(/staged[\s\S]*new\.txt/i)

    const detailHeight = async (): Promise<number> =>
      Math.round((await detail.boundingBox())?.height ?? 0)
    const handle = panel.locator('[data-split="graph-details"] .ostia-split-handle')
    await expect(handle).toHaveAttribute('role', 'separator')
    await expect(handle).toHaveAttribute('aria-orientation', 'horizontal')
    const before = await detailHeight()
    const grip = await handle.boundingBox()
    if (!grip) throw new Error('no split handle')
    const hx = Math.round(grip.x + grip.width / 2)
    const hy = Math.round(grip.y + grip.height / 2)
    await win.mouse.move(hx, hy)
    await win.mouse.down()
    await win.mouse.move(hx, hy - 40)
    await win.mouse.move(hx, hy - 80)
    await win.mouse.up()
    await expect.poll(detailHeight).toBeGreaterThan(before + 60)
    const dragged = await detailHeight()
    expect(await win.evaluate(() => String(document.getSelection()?.toString() ?? ''))).toBe('')
    await handle.focus()
    await win.keyboard.press('ArrowUp')
    const near = (target: number) => async (): Promise<boolean> =>
      Math.abs((await detailHeight()) - target) <= 2
    await expect.poll(near(dragged + 16)).toBe(true)
    const savedFraction = (): Promise<number | null> =>
      win.evaluate(() => {
        try {
          const sizes = JSON.parse(localStorage.getItem('panelSizes') ?? '{}')
          return typeof sizes['git:graph-details'] === 'number' ? sizes['git:graph-details'] : null
        } catch {
          return null
        }
      })
    await expect.poll(savedFraction).not.toBeNull()

    const toggle = win.locator('.topbar').getByRole('button', { name: 'Git', exact: true })
    await toggle.click()
    await expect(panel).toHaveCount(0)
    await showGraph()
    await worktreeRow.click()
    await expect.poll(near(dragged + 16), { timeout: 15_000 }).toBe(true)

    const list = panel.locator('.graph-scroll')
    const selectedRow = panel.locator('.graph-row[aria-selected="true"]')
    await list.focus()
    await win.keyboard.press('ArrowDown')
    await expect(selectedRow).toContainText('merge feature into main')
    await expect(detail).toContainText('feature.txt')
    await win.keyboard.press('End')
    await expect(selectedRow).toContainText('root commit')
    await win.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)

    await scope.click()
    await win.locator('.scope-menu [data-scope="all"]').click()
    await expect(panel).toContainText('side only work', { timeout: 15_000 })
    await expect(scope).toHaveText('All branches')
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const gitSetting = (key: string) => (): unknown => {
      try {
        const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
        return saved.git?.[key] ?? null
      } catch {
        return null
      }
    }
    await expect.poll(gitSetting('graphScope'), { timeout: 10_000 }).toBe('all')
    if (await win.locator('.scope-menu').isVisible()) await win.keyboard.press('Escape')

    await panel.locator('[data-key="tab-changes"]').click()
    await expect(panel).toHaveAttribute('data-page', 'changes')
    await expect(panel.locator('button.change[data-path="src/deep/feature.txt"]')).toBeVisible({
      timeout: 15_000,
    })
    await expect(panel.locator('[data-split="changes-commit"] [role="separator"]')).toHaveCount(1)
    const message = panel.locator('.commit textarea.message')
    const boxHeight = async (): Promise<number> =>
      Math.round((await message.boundingBox())?.height ?? 0)
    const emptyBox = await boxHeight()
    await message.fill(`subject\n\n${'body line\n'.repeat(8)}`)
    await expect.poll(boxHeight).toBeGreaterThan(emptyBox + 60)
    await expect(panel.locator('button.change[data-path="src/deep/feature.txt"]')).toBeVisible()
    const folders = panel.locator('button.folder')
    await expect(folders).toHaveCount(0)
    await panel.getByRole('button', { name: 'Folder tree' }).click()
    await expect
      .poll(async () =>
        (await folders.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).join('|'),
      )
      .toBe('src/deep 1|src/deep 1')
    await expect.poll(gitSetting('changesView'), { timeout: 10_000 }).toBe('tree')

    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Git', exact: true }).click()
    const changesView = settings.getByRole('combobox', { name: 'Changed files layout' })
    await expect(changesView).toContainText('Folder tree')
    await expect(settings.getByRole('combobox', { name: 'Graph branches' })).toContainText(
      'All branches',
    )
    await changesView.click()
    await win.getByRole('option', { name: 'Flat list', exact: true }).click()
    await expect(folders).toHaveCount(0, { timeout: 15_000 })
    await expect(panel.locator('[aria-label="Flat list"]')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(gitSetting('changesView'), { timeout: 10_000 }).toBe('list')
  } finally {
    await app.close()
  }
})
