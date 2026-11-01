import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace, PROMPT, runInTerminal } from './helpers'
import { sandboxedShell, setSandbox } from './sandboxShell'
import { _electron as electron, expect, type Page, test } from './test'

test.describe.configure({ timeout: 90_000 })

async function launch() {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  seedSettings(dataHome, {
    ...CANVAS_RENDERER_SETTINGS,
    workspaces: { ...CANVAS_RENDERER_SETTINGS.workspaces, defaultFolder: project },
  })
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launchOptions,
    env: { ...launchOptions.env, HOME: home },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win, home, project }
}

test('SBX-C1 a new pane in a sandboxed workspace runs under srt', async () => {
  const { app, win } = await launch()
  try {
    await setSandbox(win, true)
    await win
      .locator('.pane-actions')
      .first()
      .getByRole('button', { name: 'New terminal tab' })
      .click()
    await expect(win.locator('.terminal-text:visible')).toContainText(PROMPT, { timeout: 20_000 })
    await win.locator('.ghostty-host:visible').click()
    await win.keyboard.type('echo "proxy=$HTTPS_PROXY"')
    await win.keyboard.press('Enter')
    await expect(win.locator('.terminal-text:visible')).toContainText('proxy=http://', {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

test('SBX-C21 reads the workspace folder and the shell rc, and blocks and cwd still work', async () => {
  const { app, win, home, project } = await launch()
  try {
    writeFileSync(join(project, 'readme.txt'), 'PROJECT-README')
    writeFileSync(join(home, '.zshrc'), 'export C21_RC=loaded\n')
    mkdirSync(join(project, 'sub'), { recursive: true })
    await sandboxedShell(win)
    await runInTerminal(win, 'cat readme.txt; echo "rc=$C21_RC"; cat ~/.zshrc | head -1; cd sub')
    const rows = win.locator('.terminal-text').first()
    await expect(rows).toContainText('PROJECT-README', { timeout: 15_000 })
    await expect(rows).toContainText('export C21_RC=loaded')
    await expect(win.locator('.block-gutter').first()).toBeAttached({ timeout: 10_000 })
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await expect(win.locator('.files-panel .crumb.current')).toHaveText('sub', {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

async function openWorkspacePage(win: Page, tab: string) {
  await win.locator('.rail-row').first().click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Workspace settings…' }).click()
  const page = win.getByRole('region', { name: 'Settings' })
  await page.getByRole('tab', { name: tab }).click()
  return page
}

async function restartShell(win: Page, marker: string): Promise<void> {
  const restart = win.getByRole('button', { name: 'Restart to apply' })
  await expect(restart).toBeVisible({ timeout: 10_000 })
  await restart.click()
  await expect(restart).toHaveCount(0)
  const rows = win.locator('.terminal-text').first()
  await expect(async () => {
    await runInTerminal(win, `echo ${marker}=\${HTTPS_PROXY:+on}`)
    await expect(rows).toContainText(`${marker}=on`, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

test('with Unix sockets off the shell still starts and blocks show', async () => {
  test.skip(process.platform !== 'linux', 'Linux blocks Unix sockets through seccomp')
  test.setTimeout(120_000)
  const { app, win } = await launch()
  try {
    await sandboxedShell(win)
    const page = await openWorkspacePage(win, 'Network')
    const sockets = page.getByRole('group', { name: 'Allow Unix sockets' })
    await sockets.getByRole('switch').click()
    await expect(sockets).toContainText('Overridden')
    await win.keyboard.press('Escape')

    await restartShell(win, 'nosock')
    await expect(win.locator('.block-gutter').first()).toBeAttached({ timeout: 10_000 })
  } finally {
    await app.close()
  }
})

test('SBX-C101 a plugin keeps its state in the sandbox own plugins folder while the real one stays read-only', async () => {
  const { app, win, home, project } = await launch()
  try {
    mkdirSync(join(home, '.claude/plugins/data/codex/state'), { recursive: true })
    await sandboxedShell(win)
    await runInTerminal(
      win,
      'D=$CLAUDE_CODE_PLUGIN_CACHE_DIR; { mkdir -p $D/data/codex/state/ws/jobs; echo own=$?; touch ~/.claude/plugins/data/codex/state/x; echo real=$?; } > plugin-data.txt 2>&1; echo plugin_data_done',
    )
    await expect(win.locator('.terminal-text').first()).toContainText('plugin_data_done', {
      timeout: 20_000,
    })
    const out = readFileSync(join(project, 'plugin-data.txt'), 'utf8')
    expect(out).toContain('own=0')
    expect(out).toContain('real=1')
  } finally {
    await app.close()
  }
})
