import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { PROMPT, openWorkspace, quitApp, runInTerminal } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

async function launch(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

function tab(win: Page, title: string) {
  return win.locator('.pane-tab').filter({ hasText: title })
}

function terminal(win: Page) {
  return win.locator('.xterm-rows').first()
}

async function backToTerminal(win: Page): Promise<void> {
  await tab(win, 'zsh').getByRole('tab').click()
}

test('GIT_EDITOR="ostia --wait" commits when the tab is closed, and Ctrl+C ends a wait without closing the tab', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const repo = join(home, 'repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(home, 'notes.txt'), 'notes\n')
  const { app, win } = await launch(dataHome)
  try {
    await runInTerminal(
      win,
      'cd ~/repo && git init -q && git add a.txt && GIT_EDITOR="ostia --wait" git -c user.name=E2E -c user.email=e2e@example.com commit; echo "git-exit:$?"',
    )
    await expect(tab(win, 'COMMIT_EDITMSG')).toBeVisible({ timeout: 30_000 })
    const waited = win.getByTestId('editor-waited')
    await expect(waited).toContainText('is waiting for this tab to close')
    await expect(terminal(win)).not.toContainText(/git-exit:\d/)

    const editor = win.locator('.monaco-editor:visible').first()
    await editor.click()
    await win.keyboard.press('Control+Home')
    await win.keyboard.type('written in the waited tab')
    await win.keyboard.press('Control+s')
    await expect
      .poll(() => execFileSync('cat', [join(repo, '.git', 'COMMIT_EDITMSG')]).toString())
      .toContain('written in the waited tab')
    await waited.getByRole('button', { name: 'Close' }).click()
    await expect(tab(win, 'COMMIT_EDITMSG')).toHaveCount(0, { timeout: 15_000 })
    await expect(terminal(win)).toContainText('git-exit:0', { timeout: 20_000 })
    expect(execFileSync('git', ['-C', repo, 'log', '--format=%s', '-1']).toString().trim()).toBe(
      'written in the waited tab',
    )

    await runInTerminal(win, 'ostia --wait ~/notes.txt')
    await expect(tab(win, 'notes.txt')).toBeVisible({ timeout: 20_000 })
    await expect(win.getByTestId('editor-waited')).toBeVisible()
    await backToTerminal(win)
    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+c')
    await expect(terminal(win)).toContainText('^C', { timeout: 15_000 })
    await runInTerminal(win, 'echo back-at-the-$((1 + 1))-prompt')
    await expect(terminal(win)).toContainText('back-at-the-2-prompt', { timeout: 15_000 })
    await expect(tab(win, 'notes.txt')).toBeVisible()
    await tab(win, 'notes.txt').getByRole('tab').click()
    await expect(win.getByTestId('editor-waited')).toHaveCount(0)
  } finally {
    await quitApp(app)
  }
})

test('closing the workspace ends a waiting editor with a failure instead of hanging', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'notes.txt'), 'notes\n')
  const marker = join(home, 'wait-result.txt')
  const { app, win } = await launch(dataHome)
  try {
    await runInTerminal(
      win,
      `nohup sh -c 'ostia --wait ~/notes.txt; echo "exit:$?" > ${marker}' > /dev/null 2>&1 &`,
    )
    await expect(tab(win, 'notes.txt')).toBeVisible({ timeout: 20_000 })
    await expect(win.getByTestId('editor-waited')).toBeVisible()
    const row = win.locator('.rail-tab').first()
    await row.hover()
    await row.getByRole('button', { name: 'Close', exact: true }).click()
    const confirm = win.getByRole('dialog')
    if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await confirm.getByRole('button', { name: /Close/ }).last().click()
    }
    await expect(win.locator('.rail-tab')).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(
        () => {
          try {
            return execFileSync('cat', [marker]).toString().trim()
          } catch {
            return ''
          }
        },
        { timeout: 20_000 },
      )
      .toBe('exit:1')
  } finally {
    await quitApp(app)
  }
})

test('ostia diff, --split and -n open a comparison, a split and a new workspace', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'proj'), { recursive: true })
  writeFileSync(join(home, 'old.txt'), 'first line\nsame\n')
  writeFileSync(join(home, 'new.txt'), 'changed line\nsame\n')
  const { app, win } = await launch(dataHome)
  try {
    await runInTerminal(win, 'ostia --split down ~/new.txt')
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText('changed line', {
      timeout: 20_000,
    })
    await expect(win.locator('.xterm:visible')).toHaveCount(1)
    const term = await win.locator('.xterm:visible').boundingBox()
    const editor = await win.locator('.monaco-editor:visible').first().boundingBox()
    expect(editor && term && editor.y > term.y + term.height - 4).toBe(true)

    await win.locator('.xterm:visible').first().click()
    await runInTerminal(win, 'ostia diff ~/old.txt ~/new.txt')
    const diff = win.locator('.diff-surface:visible')
    await expect(diff).toBeVisible({ timeout: 20_000 })
    await expect(diff).toContainText('first line')
    await expect(diff).toContainText('changed line')
    await expect(tab(win, 'old.txt ↔ new.txt')).toBeVisible()

    await tab(win, 'zsh').getByRole('tab').click()
    await runInTerminal(win, 'ostia diff ~/old.txt ~/missing.txt')
    await expect(win.locator('.xterm:visible .xterm-rows').first()).toContainText(
      'missing.txt: no such file',
      { timeout: 15_000 },
    )

    await expect(win.locator('.rail-tab')).toHaveCount(1)
    await runInTerminal(win, 'ostia -n ~/proj')
    await expect(win.locator('.rail-tab')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.rail-tab').filter({ hasText: 'proj' })).toBeVisible()
    await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT)
  } finally {
    await quitApp(app)
  }
})
