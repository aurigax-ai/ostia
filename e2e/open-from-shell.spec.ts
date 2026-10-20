import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome } from './dataHome'
import { launchWindow, openWorkspace, quitApp, runInTerminal, terminalTab } from './helpers'
import { type ElectronApplication, type Page, expect, test } from './test'

async function launch(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const launched = await launchWindow(dataHome)
  await openWorkspace(launched.win)
  return launched
}

function tab(win: Page, title: string) {
  return win.locator('.pane-tab').filter({ hasText: title })
}

function terminal(win: Page) {
  return win.locator('.xterm-rows').first()
}

async function backToTerminal(win: Page): Promise<void> {
  await terminalTab(win).click()
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
    await expect(
      tab(win, 'COMMIT_EDITMSG').locator('.pane-tab-dirty, .pane-disk-mark'),
    ).toHaveCount(0)
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
