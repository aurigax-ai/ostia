import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'

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

function guest(app: ElectronApplication) {
  return (script: string): Promise<string> =>
    app.evaluate(async ({ webContents }, code) => {
      const panel = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
      return panel ? String(await panel.executeJavaScript(code)) : ''
    }, script)
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
    const inPanel = guest(app)
    const panelText = (): Promise<string> => inPanel('document.body.innerText')

    await expect(win.locator('.pane-header .pane-chip').filter({ hasText: /^main$/ })).toBeVisible({
      timeout: 15_000,
    })
    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Show Graph')
    await waitForPaletteSelection(win, 'Show Graph')
    await win.keyboard.press('Enter')

    await expect.poll(panelText, { timeout: 15_000 }).toContain('merge feature into main')
    const worktreeRow = `document.querySelector('.graph-row.worktree')`
    expect(await inPanel(`${worktreeRow}.innerText`)).toMatch(
      /Uncommitted changes[\s\S]*1 staged[\s\S]*1 unstaged/,
    )
    expect(await inPanel(`${worktreeRow}.querySelectorAll('.node.pending').length`)).toBe('1')
    expect(await inPanel(`document.querySelectorAll('.edge.pending').length > 0`)).toBe('true')
    expect(await panelText()).not.toContain('side only work')
    expect(await inPanel(`document.querySelector('.scope-trigger').innerText`)).toBe(
      'Current branch',
    )

    await inPanel(`${worktreeRow}.click(); 'ok'`)
    await expect
      .poll(() => inPanel(`document.querySelector('.detail')?.innerText ?? ''`))
      .toMatch(/STAGED[\s\S]*new\.txt/)
    const press = (key: string): Promise<string> =>
      inPanel(`(() => {
        const list = document.querySelector('.graph-scroll')
        list.focus()
        list.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))
        return 'ok'
      })()`)
    const selectedRow = (): Promise<string> =>
      inPanel(`document.querySelector('.graph-row[aria-selected="true"]')?.innerText ?? ''`)
    await press('ArrowDown')
    await expect.poll(selectedRow).toContain('merge feature into main')
    await expect
      .poll(() => inPanel(`document.querySelector('.detail')?.innerText ?? ''`))
      .toContain('feature.txt')
    await press('End')
    await expect.poll(selectedRow).toContain('root commit')
    await press('Escape')
    await expect
      .poll(() => inPanel(`String(document.querySelector('.detail') === null)`))
      .toBe('true')

    await inPanel(`document.querySelector('.scope-trigger').click(); 'ok'`)
    await inPanel(`document.querySelector('input[type="radio"][value="all"]').click(); 'ok'`)
    await expect.poll(panelText, { timeout: 15_000 }).toContain('side only work')
    expect(await inPanel(`document.querySelector('.scope-trigger').innerText`)).toBe('All branches')
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    const gitSetting = (key: string) => (): unknown => {
      try {
        const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
        return saved.extensionSettings?.git?.[key] ?? null
      } catch {
        return null
      }
    }
    await expect.poll(gitSetting('graphScope'), { timeout: 10_000 }).toBe('all')

    await inPanel(`document.querySelector('[data-key="tab-changes"]').click(); 'ok'`)
    await expect.poll(panelText, { timeout: 15_000 }).toContain('feature.txt')
    expect(await inPanel(`document.querySelectorAll('button.folder').length`)).toBe('0')
    await inPanel(`document.querySelector('[aria-label="Folder tree"]').click(); 'ok'`)
    await expect
      .poll(() =>
        inPanel(
          `[...document.querySelectorAll('button.folder')].map((b) => b.innerText.replace(/\\s+/g, ' ').trim()).join('|')`,
        ),
      )
      .toBe('src/deep 1|src/deep 1')
    await expect.poll(gitSetting('changesView'), { timeout: 10_000 }).toBe('tree')

    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Plugins', exact: true }).click()
    const changesView = settings.getByRole('combobox', { name: 'changesView' })
    await expect(changesView).toContainText('tree')
    await expect(settings.getByRole('combobox', { name: 'graphScope' })).toContainText('all')
    await changesView.click()
    await win.getByRole('option', { name: 'list', exact: true }).click()
    await expect
      .poll(() => inPanel(`document.querySelectorAll('button.folder').length`), { timeout: 15_000 })
      .toBe('0')
    expect(
      await inPanel(
        `document.querySelector('[aria-label="Flat list"]').getAttribute('aria-pressed')`,
      ),
    ).toBe('true')
    await expect.poll(gitSetting('changesView'), { timeout: 10_000 }).toBe('list')
  } finally {
    await app.close()
  }
})
