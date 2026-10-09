import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { PRODUCT_NAME } from '../src/shared/product'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, openWorkspace, runInTerminal } from './helpers'
import { UPSTREAM_BODY, fakeUpstream, freePort, sandboxedShell, setSandbox } from './sandboxShell'
import { type Page, _electron as electron, expect, test } from './test'

async function launch(env: Record<string, string> = {}) {
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
  const app = await electron.launch({
    ...launchOptions,
    env: { ...launchOptions.env, HOME: home, ...env },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win, home, project, dataHome }
}

test('SBX-C1 a new pane in a sandboxed workspace runs under srt and cannot read ~/.ssh', async () => {
  const { app, win, home } = await launch()
  try {
    await setSandbox(win, true)
    await win
      .locator('.pane-actions')
      .first()
      .getByRole('button', { name: 'New terminal tab' })
      .click()
    await expect(win.locator('.xterm-rows:visible')).toContainText(PROMPT, { timeout: 20_000 })
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
  const upstream = await fakeUpstream()
  const target = 'http://allowed.ostia-e2e.test/hello'
  const { app, win } = await launch({
    HTTP_PROXY: upstream.url,
    http_proxy: upstream.url,
    NO_PROXY: '',
    no_proxy: '',
  })
  try {
    await sandboxedShell(win)
    await runInTerminal(win, `curl -s -m 60 -w "\\ncode=%{http_code}\\n" ${target}`)
    const card = win.getByRole('region', { name: 'Agent permission request' })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('allowed.ostia-e2e.test')
    expect(upstream.requested).toEqual([])
    await card.getByRole('button', { name: 'Allow for this workspace' }).click()
    const rows = win.locator('.xterm-rows').first()
    await expect(rows).toContainText('code=200', { timeout: 30_000 })
    await expect(rows).toContainText(UPSTREAM_BODY)
    expect(upstream.requested).toEqual([target])
  } finally {
    await app.close()
    upstream.server.close()
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

test('SBX-C24 reaches Ostia from a sandboxed shell through the control socket', async () => {
  const { app, win } = await launch()
  try {
    await sandboxedShell(win)
    await runInTerminal(win, 'ostia whoami && echo C24-OK')
    await expect(win.locator('.xterm-rows').first()).toContainText('C24-OK', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

function serveInside(port: number, body: string): string {
  const script = `require("http").createServer((q,r)=>r.end("${body}")).listen(${port},"127.0.0.1")`
  return `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" -e '${script}' &`
}

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
  copyFileSync(join(fixture, 'ostia.json'), join(dir, 'ostia.json'))
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
    await runInTerminal(
      win,
      `ostia opener run sh -c 'cat ${home}/.ssh/id_ed25519 || echo C3-$(echo DENIED)'`,
    )
    const opened = win.locator('.xterm-rows').filter({ hasText: 'C3-DENIED' })
    try {
      await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 45_000 })
      await expect(opened).toHaveCount(1, { timeout: 45_000 })
    } catch (error) {
      const terminals = await win.locator('.xterm-rows').allTextContents()
      const logFile = join(dataHome, 'userData', 'logs', 'main.log')
      const logTail = existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-4000) : 'no log'
      throw new Error(
        `${(error as Error).message}\nterminals: ${JSON.stringify(terminals, null, 2)}\nmain log tail:\n${logTail}`,
      )
    }
    await expect(win.locator('.xterm-rows').filter({ hasText: 'SECRET-KEY-MATERIAL' })).toHaveCount(
      0,
    )
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

async function sttySize(win: Page, marker: string): Promise<string> {
  const rows = win.locator('.xterm-rows').first()
  await runInTerminal(win, `echo ${marker}=$(stty size | tr -c 0-9 x)=`)
  const pattern = new RegExp(`${marker}=(\\d+x\\d+)x=`)
  await expect(rows).toContainText(pattern, { timeout: 15_000 })
  return pattern.exec((await rows.textContent()) ?? '')?.[1] ?? ''
}

test('behind the pty relay a sandboxed shell has its own terminal: Ctrl+C interrupts, Ctrl+Z suspends, a resize arrives and blocks show', async () => {
  test.skip(process.platform !== 'linux', 'the pty relay exists only on Linux (TIOCSTI)')
  test.setTimeout(120_000)
  const { app, win } = await launch({ OSTIA_SANDBOX_PTY_RELAY: '1' })
  try {
    await sandboxedShell(win)
    const rows = win.locator('.xterm-rows').first()
    await runInTerminal(win, 'echo "parent=$(ps -o comm= -p $PPID) tty=$(tty)"')
    await expect(rows).toContainText(/parent=script tty=\/dev\/pts\/\d+/, { timeout: 15_000 })

    await runInTerminal(win, "sh -c 'echo SLEEPING-$((1+2)); exec sleep 30'; echo SLEPT-$((2+3))")
    await expect(rows).toContainText('SLEEPING-3', { timeout: 15_000 })
    await win.keyboard.press('Control+c')
    await runInTerminal(win, 'echo ALIVE-$((6*7))')
    await expect(rows).toContainText('ALIVE-42', { timeout: 15_000 })
    await expect(rows).not.toContainText('SLEPT-5')

    await runInTerminal(win, "sh -c 'echo PAUSING-$((2+2)); exec sleep 30'")
    await expect(rows).toContainText('PAUSING-4', { timeout: 15_000 })
    await win.keyboard.press('Control+z')
    await expect(rows).toContainText(/suspended|Stopped/, { timeout: 15_000 })
    await runInTerminal(win, 'kill %1; echo JOBS-$((5+5))')
    await expect(rows).toContainText('JOBS-10', { timeout: 15_000 })
    await expect(win.locator('.block-gutter').first()).toBeAttached({ timeout: 10_000 })

    const before = await sttySize(win, 'W1')
    expect(before).toMatch(/^\d+x\d+$/)
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0]
      const [width, height] = main.getSize()
      main.setSize(width - 240, height)
    })
    await expect(async () => {
      const marker = `W${Date.now()}`
      expect(await sttySize(win, marker)).not.toBe(before)
    }).toPass({ timeout: 30_000 })
  } finally {
    await app.close()
  }
})

test('with Unix sockets off the shell still starts, ostia cannot reach Ostia, a port is not exposed and the Ports tab says why, and a write outside is listed', async () => {
  test.skip(process.platform !== 'linux', 'Linux blocks Unix sockets through seccomp')
  test.setTimeout(120_000)
  const { app, win } = await launch()
  try {
    await sandboxedShell(win)
    const rows = win.locator('.xterm-rows').first()
    await runInTerminal(win, 'ostia whoami >/dev/null && echo REACHED-$((7+7))')
    await expect(rows).toContainText('REACHED-14', { timeout: 15_000 })

    const page = await openWorkspacePage(win, 'Network')
    const sockets = page.getByRole('group', { name: 'Allow Unix sockets' })
    await expect(sockets).toContainText('the ostia command')
    await sockets.getByRole('switch').click()
    await expect(sockets).toContainText('Overridden')
    await win.keyboard.press('Escape')

    await restartShell(win, 'nosock')
    await runInTerminal(win, 'ostia whoami >/dev/null 2>&1 || echo UNREACHABLE-$((8+8))')
    await expect(rows).toContainText('UNREACHABLE-16', { timeout: 15_000 })
    await runInTerminal(win, 'echo x > /etc/ostia-e2e-probe; echo PROBED-$((9+9))')
    await expect(rows).toContainText('PROBED-18', { timeout: 15_000 })
    await expect(win.locator('.block-gutter').first()).toBeAttached({ timeout: 10_000 })

    const port = await freePort()
    await runInTerminal(win, serveInside(port, 'INSIDE-NOSOCK'))
    const ports = await openWorkspacePage(win, 'Ports')
    const server = ports.getByRole('listitem').filter({ hasText: `:${port}` })
    await expect(server).toBeVisible({ timeout: 20_000 })
    await expect(win.getByRole('region', { name: 'Agent permission request' })).toHaveCount(0)
    await server.getByRole('button', { name: 'Expose' }).click()
    await expect(ports.getByRole('alert')).toContainText(
      `Port ${port} cannot be exposed while Unix sockets are off for this sandbox.`,
    )
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
    await win.keyboard.press('Escape')

    const blocked = await openWorkspacePage(win, 'Blocked')
    const row = blocked
      .getByRole('list', { name: 'Blocked' })
      .getByRole('listitem')
      .filter({ hasText: '/etc/ostia-e2e-probe' })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toContainText('Write')
  } finally {
    await app.close()
  }
})
