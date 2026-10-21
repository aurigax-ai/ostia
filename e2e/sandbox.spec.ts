import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, openWorkspace, runInTerminal } from './helpers'
import { sandboxedShell, setSandbox } from './sandboxShell'
import { type Page, _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 90_000 })

async function launch() {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
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
    await expect(win.locator('.xterm-rows:visible')).toContainText(PROMPT, { timeout: 20_000 })
    await win.locator('.xterm:visible').click()
    await win.keyboard.type('echo "proxy=$HTTPS_PROXY"')
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows:visible')).toContainText('proxy=http://', {
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
    const rows = win.locator('.xterm-rows').first()
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
  const rows = win.locator('.xterm-rows').first()
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
