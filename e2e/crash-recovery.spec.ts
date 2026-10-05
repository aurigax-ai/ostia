import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'

const GRACE_OUTLIVED_MS = 5_000

interface Launched {
  app: ElectronApplication
  win: Page
  dataHome: string
  home: string
}

async function launch(): Promise<Launched> {
  const dataHome = freshDataHome()
  const launchOpts = isolatedLaunch(dataHome)
  const app = await electron.launch(launchOpts)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win, dataHome, home: launchOpts.home }
}

async function closeQuietly(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => app.process().kill('SIGKILL'))
}

function mainLog(dataHome: string): string {
  const file = join(dataHome, 'userData', 'logs', 'main.log')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function collectPageErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (err) => errors.push(err.message))
  return errors
}

async function run(win: Page, index: number, command: string): Promise<void> {
  await win.locator('.xterm').nth(index).click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

async function shellPid(win: Page, index: number, tag: string): Promise<string> {
  await run(win, index, `echo ${tag}-$$`)
  const rows = win.locator('.xterm-rows').nth(index)
  await expect(rows).toContainText(new RegExp(`${tag}-\\d+`), { timeout: 15_000 })
  const match = (await rows.innerText()).match(new RegExp(`${tag}-(\\d+)`))
  return match?.[1] ?? ''
}

test('a renderer error shows the recovery screen, and Reload window brings the same shells back', async () => {
  test.setTimeout(120_000)
  const { app, win, dataHome } = await launch()
  try {
    await openWorkspace(win)
    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.xterm-rows').nth(1)).toContainText(PROMPT, { timeout: 15_000 })
    const before = [await shellPid(win, 0, 'left'), await shellPid(win, 1, 'right')]

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('diagnostics:test-crash')
    })
    await expect(win.getByRole('heading', { name: 'Something went wrong' })).toBeVisible({
      timeout: 10_000,
    })
    await expect(win.getByText('test crash requested by the E2E hook')).toBeVisible()
    await expect(win.locator('.xterm')).toHaveCount(0)
    await win.waitForTimeout(GRACE_OUTLIVED_MS)

    await win.getByRole('button', { name: 'Reload window' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 20_000 })
    await expect(win.locator('.xterm-rows').nth(0)).toContainText(`left-${before[0]}`, {
      timeout: 15_000,
    })
    const after = [await shellPid(win, 0, 'leftagain'), await shellPid(win, 1, 'rightagain')]
    expect(after).toEqual(before)

    const log = mainLog(dataHome)
    expect(log).toMatch(/renderer-error window=\d+ kind=render message="test crash requested/)
    expect(log).toMatch(/window-recovering window=\d+ reason=render-error/)
    expect(log).toMatch(/window-reload window=\d+/)
    expect(log).not.toMatch(/pty-reap .*reason=grace-expired/)
  } finally {
    await app.close()
  }
})

test.describe('renderer crash', () => {
  test.describe.configure({
    retries: process.env.CI && process.platform === 'linux' ? 2 : 0,
  })

  test('a renderer process crash reloads the window and keeps the shells alive', async () => {
    test.info().annotations.push({
      type: 'PINE-63',
      description:
        'on the Ubuntu runner Pine sometimes never sees the killed renderer; retried on Linux CI',
    })
    test.setTimeout(120_000)
    const { app, win, dataHome } = await launch()
    try {
      await openWorkspace(win)
      const before = await shellPid(win, 0, 'crashpid')
      const snapshotFile = join(dataHome, 'ostia', 'workspaces.json')
      await expect
        .poll(() => (existsSync(snapshotFile) ? readFileSync(snapshotFile, 'utf8') : ''), {
          timeout: 10_000,
        })
        .toContain('"kind": "terminal"')

      const processFacts = () =>
        app.evaluate(({ BrowserWindow, webContents, app: electronApp }) => ({
          windows: BrowserWindow.getAllWindows().map((w) => ({
            window: w.id,
            contents: w.webContents.id,
            pid: w.webContents.getOSProcessId(),
            visible: w.isVisible(),
            crashed: w.webContents.isCrashed(),
          })),
          contents: webContents
            .getAllWebContents()
            .map((c) => ({ id: c.id, type: c.getType(), pid: c.getOSProcessId() })),
          metrics: electronApp
            .getAppMetrics()
            .map((m) => ({ pid: m.pid, type: m.type, name: m.name })),
        }))
      const factsBefore = await processFacts()
      const killed = await app.evaluate(({ BrowserWindow }) => {
        const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId()
        if (pid) setImmediate(() => process.kill(pid, 'SIGKILL'))
        return pid ?? 0
      })
      try {
        await expect
          .poll(() => mainLog(dataHome), { timeout: 15_000 })
          .toMatch(/render-process-gone/)
      } catch (error) {
        const factsAfter = await processFacts().catch((e) => String(e))
        throw new Error(
          `PINE-63 killed pid ${killed}: ${JSON.stringify({ factsBefore, factsAfter })}\n${String(error)}`,
        )
      }
      const terminalText = () =>
        app
          .evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
              "[...document.querySelectorAll('.xterm-rows')].map((r) => r.textContent).join('\\n')",
            ),
          )
          .catch(() => '')
      await expect
        .poll(terminalText, { timeout: 30_000, message: 'terminal text after the crash reload' })
        .toContain(`crashpid-${before}`)
      await new Promise((resolve) => setTimeout(resolve, GRACE_OUTLIVED_MS))
      expect(() => process.kill(Number(before), 0)).not.toThrow()
      expect(mainLog(dataHome)).toMatch(/renderer-reload window=\d+/)
    } finally {
      await closeQuietly(app)
    }
  })
})

test('closing a diff tab keeps the window and the other terminals working', async () => {
  test.setTimeout(90_000)
  const { app, win, dataHome, home } = await launch()
  const pageErrors = collectPageErrors(win)
  try {
    const vcs = (...args: string[]) =>
      execFileSync('git', args, { cwd: home, env: { ...process.env, HOME: home } })
    vcs('init', '-q')
    writeFileSync(join(home, 'a.txt'), 'one\n')
    vcs('add', 'a.txt')
    vcs('commit', '-qm', 'init')
    writeFileSync(join(home, 'a.txt'), 'one\ntwo\n')

    await openWorkspace(win)
    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await run(win, 0, 'pine git open a.txt')
    const diffTab = win.locator('.pane-tab', { hasText: 'a.txt' })
    await expect(win.locator('.diff-surface')).toBeVisible({ timeout: 15_000 })

    await diffTab.hover()
    await diffTab.getByRole('button', { name: 'Close tab' }).click()
    await expect(win.locator('.diff-surface')).toHaveCount(0)
    await win.waitForTimeout(4_000)

    await expect(win.locator('.xterm')).toHaveCount(2)
    await expect(win.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0)
    await run(win, 1, 'echo after_diff_$((6*7))')
    await expect(win.locator('.xterm-rows').nth(1)).toContainText('after_diff_42', {
      timeout: 15_000,
    })
    expect(pageErrors).toEqual([])
    expect(mainLog(dataHome)).not.toMatch(/renderer-error|pty-reap/)
  } finally {
    await app.close()
  }
})
