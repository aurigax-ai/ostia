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

type PanelInput =
  | {
      type: 'mouseMove' | 'mouseDown' | 'mouseUp'
      x: number
      y: number
      button?: 'left'
      clickCount?: number
      modifiers?: string[]
    }
  | { type: 'keyDown' | 'keyUp'; keyCode: string }

const HELD = ['leftButtonDown']

function sendToPanel(app: ElectronApplication, events: PanelInput[]): Promise<void> {
  return app.evaluate(({ webContents }, list) => {
    const panel = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
    for (const event of list) panel?.sendInputEvent(event as Electron.InputEvent)
  }, events)
}

function reloadPanel(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ webContents }) => {
    webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
      ?.reload()
  })
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

    const detailHeight = async (): Promise<number> =>
      Number(
        await inPanel(
          `Math.round(document.querySelector('.detail').getBoundingClientRect().height)`,
        ),
      )
    const handle = `document.querySelector('.pine-split-handle')`
    expect(await inPanel(`${handle}.getAttribute('role')`)).toBe('separator')
    expect(await inPanel(`${handle}.getAttribute('aria-orientation')`)).toBe('horizontal')
    const before = await detailHeight()
    const [hx, hy] = JSON.parse(
      await inPanel(
        `JSON.stringify((() => { const r = ${handle}.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top)] })())`,
      ),
    ) as [number, number]
    await sendToPanel(app, [
      { type: 'mouseMove', x: hx, y: hy },
      { type: 'mouseDown', x: hx, y: hy, button: 'left', clickCount: 1, modifiers: HELD },
      { type: 'mouseMove', x: hx, y: hy - 40, button: 'left', modifiers: HELD },
      { type: 'mouseMove', x: hx, y: hy - 80, button: 'left', modifiers: HELD },
      { type: 'mouseUp', x: hx, y: hy - 80, button: 'left', clickCount: 1 },
    ])
    await expect.poll(detailHeight).toBeGreaterThan(before + 60)
    const dragged = await detailHeight()
    expect(await inPanel(`String(document.getSelection().toString())`)).toBe('')
    await inPanel(`${handle}.focus(); 'ok'`)
    await sendToPanel(app, [
      { type: 'keyDown', keyCode: 'Up' },
      { type: 'keyUp', keyCode: 'Up' },
    ])
    const near = (target: number) => async (): Promise<boolean> =>
      Math.abs((await detailHeight()) - target) <= 2
    await expect.poll(near(dragged + 16)).toBe(true)
    const sizesFile = join(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')),
      'extension-data',
      'git',
      'panel-sizes.json',
    )
    const savedFraction = (): number | null => {
      try {
        return JSON.parse(readFileSync(sizesFile, 'utf8'))['graph-details'] ?? null
      } catch {
        return null
      }
    }
    await expect.poll(savedFraction).not.toBeNull()

    await reloadPanel(app)
    await expect.poll(panelText, { timeout: 15_000 }).toContain('merge feature into main')
    await inPanel(`${worktreeRow}.click(); 'ok'`)
    await expect.poll(near(dragged + 16), { timeout: 15_000 }).toBe(true)
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
    expect(
      await inPanel(
        `String(document.querySelector('[data-split="changes-commit"] [role="separator"]') !== null)`,
      ),
    ).toBe('true')
    const boxHeight = async (): Promise<number> =>
      Number(
        await inPanel(
          `Math.round(document.querySelector('textarea.message').getBoundingClientRect().height)`,
        ),
      )
    const emptyBox = await boxHeight()
    await inPanel(`(() => {
      const box = document.querySelector('textarea.message')
      box.value = 'subject\\n\\n' + 'body line\\n'.repeat(8)
      box.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
    await expect.poll(boxHeight).toBeGreaterThan(emptyBox + 60)
    expect(await panelText()).toContain('feature.txt')
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

    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
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
