import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { buildSync } from 'esbuild'
import { PRODUCT_NAME } from '../src/shared/product'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

async function launch() {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'SECRET-KEY-MATERIAL')
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
  })
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launchOptions, env: { ...launchOptions.env, HOME: home } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win, home, project, dataHome }
}

async function run(win: Page, command: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

async function setSandbox(win: Page, on: boolean): Promise<void> {
  await win.locator('.rail-row').first().click({ button: 'right' })
  const item = win.getByRole('menuitemcheckbox', { name: 'Sandbox' })
  await expect(item).toHaveAttribute('aria-checked', on ? 'false' : 'true')
  await item.click()
}

async function sandboxedShell(win: Page): Promise<void> {
  await setSandbox(win, true)
  const restart = win.getByRole('button', { name: 'Restart to apply' })
  await restart.click()
  await expect(restart).toHaveCount(0)
  const rows = win.locator('.xterm-rows').first()
  await expect(async () => {
    await run(win, 'echo "sandbox=${HTTPS_PROXY:+on}"')
    await expect(rows).toContainText('sandbox=on', { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

test('SBX-C5 a workspace with the sandbox off spawns an unwrapped shell', async () => {
  const { app, win, home } = await launch()
  try {
    await run(win, `cat ${home}/.ssh/id_ed25519; echo C5-DONE`)
    await expect(win.locator('.xterm-rows').first()).toContainText('SECRET-KEY-MATERIAL', {
      timeout: 15_000,
    })
    await expect(win.getByRole('button', { name: 'Restart to apply' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('SBX-C6 turning the sandbox on asks running panes to restart, and the restart sandboxes them', async () => {
  const { app, win, home } = await launch()
  try {
    await setSandbox(win, true)
    const restart = win.getByRole('button', { name: 'Restart to apply' })
    await expect(restart).toBeVisible({ timeout: 10_000 })
    await restart.click()
    await expect(restart).toHaveCount(0)
    await expect(win.locator('.xterm-rows').first()).toContainText(/[❯$%#]/, { timeout: 20_000 })
    await run(win, `cat ${home}/.ssh/id_ed25519 || echo C6-DENIED`)
    await expect(win.locator('.xterm-rows').first()).toContainText('C6-DENIED', {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

test('SBX-C1 a new pane in a sandboxed workspace runs under srt and cannot read ~/.ssh', async () => {
  const { app, win, home } = await launch()
  try {
    await setSandbox(win, true)
    await win
      .locator('.pane-actions')
      .first()
      .getByRole('button', { name: 'New terminal tab' })
      .click()
    await expect(win.locator('.xterm-rows:visible')).toContainText(/[❯$%#]/, { timeout: 20_000 })
    await win.locator('.xterm:visible').click()
    await win.keyboard.type(
      `cat ${home}/.ssh/id_ed25519 || echo C1-DENIED; echo "proxy=$HTTPS_PROXY"`,
    )
    await win.keyboard.press('Enter')
    const rows = win.locator('.xterm-rows:visible')
    await expect(rows).toContainText('C1-DENIED', { timeout: 15_000 })
    await expect(rows).toContainText('proxy=http://')
    await expect(rows).not.toContainText('SECRET-KEY-MATERIAL')
  } finally {
    await app.close()
  }
})

test('a blocked connection waits on the card and completes once the human allows the host', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch()
  try {
    await sandboxedShell(win)
    await run(win, 'curl -s -m 60 -o /dev/null -w "code=%{http_code}\\n" https://example.com')
    const card = win.getByRole('region', { name: 'Agent permission request' })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('example.com')
    await card.getByRole('button', { name: 'Allow for this workspace' }).click()
    await expect(win.locator('.xterm-rows').first()).toContainText(/code=[1-5]\d\d/, {
      timeout: 30_000,
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
    await run(win, 'cat readme.txt; echo "rc=$C21_RC"; cat ~/.zshrc | head -1; cd sub')
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

test('SBX-C24 reaches Pine from a sandboxed shell through the control socket', async () => {
  const { app, win } = await launch()
  try {
    await sandboxedShell(win)
    await run(win, 'pine whoami && echo C24-OK')
    await expect(win.locator('.xterm-rows').first()).toContainText('C24-OK', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

const FAKE_BIN = join(__dirname, '../test/fixtures/system/bin')

async function launchWithFakeSystem() {
  const dataHome = freshDataHome()
  const log = join(dataHome, 'system-calls.log')
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
    env: {
      ...launchOptions.env,
      HOME: home,
      PATH: `${FAKE_BIN}:${process.env.PATH}`,
      FAKE_SYSTEM_LOG: log,
    },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win, log }
}

async function answerDialogs(app: Awaited<ReturnType<typeof electron.launch>>, response: number) {
  await app.evaluate(({ dialog }, answer) => {
    const g = globalThis as { pineE2eAsked?: unknown[] }
    g.pineE2eAsked = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.pineE2eAsked?.push(args.length > 1 ? args[1] : args[0])
      return { response: answer, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, response)
}

test('SBX-C87 installs a system package from a sandbox in a Host pane that closes when done', async () => {
  test.setTimeout(120_000)
  const { app, win, log } = await launchWithFakeSystem()
  try {
    await sandboxedShell(win)
    await answerDialogs(app, 0)
    await run(win, 'pine system install jq --manager pacman --reason c87')
    await expect
      .poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''), { timeout: 30_000 })
      .toContain('pacman -S --needed jq')
    await expect(win.locator('.xterm')).toHaveCount(1, { timeout: 30_000 })
    await expect(win.locator('.xterm-rows').first()).toContainText('"approved": true', {
      timeout: 15_000,
    })
    const asked = (await app.evaluate(
      () => (globalThis as { pineE2eAsked?: unknown[] }).pineE2eAsked ?? [],
    )) as { detail?: string }[]
    expect(asked[0]?.detail).toContain('Runs outside the sandbox')
  } finally {
    await app.close()
  }
})

test('SBX-C88 opens no pane when the human denies a system install from a sandbox', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launchWithFakeSystem()
  try {
    await sandboxedShell(win)
    await answerDialogs(app, 1)
    await run(win, 'pine system install jq --manager pacman --reason c88')
    await expect(win.locator('.xterm-rows').first()).toContainText('denied', { timeout: 20_000 })
    await expect(win.locator('.xterm')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('SBX-C3 sandboxes a terminal an extension opens in a sandboxed workspace', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'SECRET-KEY-MATERIAL')
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
  })
  const launchOptions = isolatedLaunch(dataHome)
  const fixture = join(__dirname, '..', 'test', 'fixtures', 'extensions-e2e', 'terminal-opener')
  const dir = join(launchOptions.env.XDG_CONFIG_HOME, PRODUCT_NAME, 'extensions', 'opener')
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(fixture, 'pine.json'), join(dir, 'pine.json'))
  buildSync({
    entryPoints: [join(fixture, 'main.js')],
    outfile: join(dir, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
  })
  const app = await electron.launch({ ...launchOptions, env: { ...launchOptions.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const approval = win.getByRole('dialog').filter({ hasText: 'Opener' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await openWorkspace(win)
    await sandboxedShell(win)
    await run(win, `pine opener run sh -c 'cat ${home}/.ssh/id_ed25519 || echo C3-$(echo DENIED)'`)
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 20_000 })
    const opened = win.locator('.xterm-rows').filter({ hasText: 'C3-DENIED' })
    await expect(opened).toHaveCount(1, { timeout: 20_000 })
    await expect(win.locator('.xterm-rows').filter({ hasText: 'SECRET-KEY-MATERIAL' })).toHaveCount(
      0,
    )
  } finally {
    await app.close()
  }
})

test('SBX-C57 shows every sandbox setting on the workspace page and in Settings › Sandbox', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch()
  try {
    await win.locator('.rail-row').first().click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Workspace settings…' }).click()
    const page = win.getByRole('region', { name: 'Settings' })
    await expect(page.getByRole('heading', { name: 'Workspace: project' })).toBeVisible({
      timeout: 15_000,
    })
    const tabs: [string, string][] = [
      ['General', 'Sandbox this workspace'],
      ['Files', 'Readable folders'],
      ['Network', 'Allowed domains'],
      ['Ports', 'When a new server starts'],
      ['Secrets', 'Env and file grants'],
      ['Packages', 'Cooldown (days)'],
      ['Pine access', 'Act on other workspaces'],
    ]
    for (const [tab, control] of tabs) {
      await page.getByRole('tab', { name: tab }).click()
      await expect(page.getByRole('tabpanel', { name: tab })).toContainText(control)
    }
    await page.getByRole('button', { name: 'Sandbox', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Allowed domains' })).toContainText(
      'api.anthropic.com',
    )
    await expect(page.getByRole('group', { name: 'Readable folders' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Cooldown (days)' })).toBeVisible()
  } finally {
    await app.close()
  }
})
