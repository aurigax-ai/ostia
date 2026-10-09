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

test('SBX-C5 a workspace with the sandbox off spawns an unwrapped shell', async () => {
  const { app, win, home } = await launch()
  try {
    await runInTerminal(win, `cat ${home}/.ssh/id_ed25519; echo C5-DONE`)
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
    await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 20_000 })
    await runInTerminal(win, `cat ${home}/.ssh/id_ed25519 || echo C6-DENIED`)
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

test('SBX-C2 ostia process run in a sandboxed workspace runs its command in a sandboxed tab', async () => {
  const { app, win, home } = await launch()
  try {
    await sandboxedShell(win)
    await runInTerminal(
      win,
      `ostia process run "cat ${home}/.ssh/id_ed25519 || echo C2-\\$((1+1))-DENIED; echo proxy=\\\${HTTPS_PROXY:+on}" --name probe`,
    )
    const tab = win.locator('.xterm-rows').filter({ hasText: 'C2-2-DENIED' })
    await expect(tab).toHaveCount(1, { timeout: 30_000 })
    await expect(tab).toContainText('proxy=on')
    await expect(win.locator('.xterm-rows').filter({ hasText: 'SECRET-KEY-MATERIAL' })).toHaveCount(
      0,
    )
  } finally {
    await app.close()
  }
})

function serveInside(port: number, body: string): string {
  const script = `require("http").createServer((q,r)=>r.end("${body}")).listen(${port},"127.0.0.1")`
  return `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" -e '${script}' &`
}

for (const relay of [false, true]) {
  const terminal = relay ? 'behind the pty relay' : 'on the pane’s own terminal'
  test(`SBX-C45 ostia sandbox expose forwards the port on this computer to a server in the sandbox once the human allows it, ${terminal}`, async () => {
    test.skip(process.platform !== 'linux', 'macOS reaches sandboxed servers without forwarding')
    test.setTimeout(120_000)
    const port = await freePort()
    const { app, win } = await launch(relay ? { OSTIA_SANDBOX_PTY_RELAY: '1' } : {})
    try {
      await sandboxedShell(win)
      const rows = win.locator('.xterm-rows').first()
      await runInTerminal(win, `ostia sandbox expose ${port}`)
      const card = win.getByRole('region', { name: 'Agent permission request' })
      await expect(card).toContainText(`wants to expose port ${port}`, { timeout: 20_000 })
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
      await card.getByRole('button', { name: 'Allow for this workspace' }).click()
      await expect(rows).toContainText(`exposed: 127.0.0.1:${port}`, { timeout: 15_000 })
      await runInTerminal(win, serveInside(port, 'INSIDE-C45'))
      await expect(async () => {
        expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('INSIDE-C45')
      }).toPass({ timeout: 30_000 })
    } finally {
      await app.close()
    }
  })
}

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
    const g = globalThis as { ostiaE2eAsked?: unknown[] }
    g.ostiaE2eAsked = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.ostiaE2eAsked?.push(args.length > 1 ? args[1] : args[0])
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
    await runInTerminal(win, 'ostia system install jq --manager pacman --reason c87')
    await expect
      .poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''), { timeout: 30_000 })
      .toContain('pacman -S --needed jq')
    await expect(win.locator('.xterm')).toHaveCount(1, { timeout: 30_000 })
    await expect(win.locator('.xterm-rows').first()).toContainText('"approved": true', {
      timeout: 15_000,
    })
    const asked = (await app.evaluate(
      () => (globalThis as { ostiaE2eAsked?: unknown[] }).ostiaE2eAsked ?? [],
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
    await runInTerminal(win, 'ostia system install jq --manager pacman --reason c88')
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
      ['Files', 'Writable folders'],
      ['Files', 'Hidden paths'],
      ['Files', 'Read-only paths'],
      ['Network', 'Allowed domains'],
      ['Network', 'Blocked domains'],
      ['Network', 'Allow Unix sockets'],
      ['Ports', 'When a new server starts'],
      ['Secrets', 'Env and file grants'],
      ['Packages', 'Cooldown (days)'],
      ['Ostia access', 'Act on other workspaces'],
      ['Blocked', 'Nothing was blocked.'],
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
    await expect(page.getByRole('group', { name: 'Writable folders' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Allow Unix sockets' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Cooldown (days)' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a sandboxed shell survives Ctrl+C, which still interrupts its command, and has a temp folder that exists', async () => {
  const { app, win } = await launch()
  try {
    await sandboxedShell(win)
    const rows = win.locator('.xterm-rows').first()

    await win.locator('.xterm').first().click()
    await win.keyboard.type('half-typed')
    await expect(rows).toContainText('half-typed')
    await win.keyboard.press('Control+c')
    await expect(rows).toContainText(new RegExp(`half-typed.*${PROMPT.source}`), {
      timeout: 15_000,
    })
    await runInTerminal(win, "sh -c 'echo SLEEPING-$((1+2)); exec sleep 30'; echo SLEPT-$((2+3))")
    await expect(rows).toContainText('SLEEPING-3', { timeout: 15_000 })
    await win.keyboard.press('Control+c')
    await expect(rows).toContainText(new RegExp(`SLEEPING-3.*${PROMPT.source}`), {
      timeout: 15_000,
    })
    await runInTerminal(win, 'echo ALIVE-$((6*7))')
    await expect(rows).toContainText('ALIVE-42', { timeout: 15_000 })
    if (process.platform === 'darwin') {
      test.info().annotations.push({
        type: 'skipped assertion',
        description: 'bash 3.2 runs the rest of the ; list after SIGINT, so SLEPT-5 is printed',
      })
    } else {
      await expect(rows).not.toContainText('SLEPT-5')
    }

    await runInTerminal(win, 'touch "$TMPDIR/probe" && test -d "$TMPDIR" && echo TMP-$((4+4))')
    await expect(rows).toContainText('TMP-8', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('a sandboxed shell keeps its temp folder when another Ostia quits', async () => {
  const { app, win } = await launch()
  try {
    await sandboxedShell(win)
    const other = await electron.launch(isolatedLaunch())
    await other.firstWindow()
    await other.close()
    await runInTerminal(win, 'touch "$TMPDIR/probe" && test -d "$TMPDIR" && echo KEPT-$((5+4))')
    await expect(win.locator('.xterm-rows').first()).toContainText('KEPT-9', { timeout: 15_000 })
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

async function addToList(page: ReturnType<Page['getByRole']>, list: string, value: string) {
  const group = page.getByRole('group', { name: list })
  await group.getByRole('textbox').fill(value)
  await group.getByRole('button', { name: 'Add' }).click()
  await expect(group.getByRole('button', { name: `Remove ${value}` })).toBeVisible()
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

test('a folder added as writable in Settings can be written from the sandbox once the shell restarts', async () => {
  test.setTimeout(120_000)
  const { app, win, home } = await launch()
  try {
    mkdirSync(join(home, 'builds'))
    await sandboxedShell(win)
    const rows = win.locator('.xterm-rows').first()
    await runInTerminal(win, `echo early > ${home}/builds/early.txt; echo BEFORE-$((1+1))`)
    await expect(rows).toContainText('BEFORE-2', { timeout: 15_000 })
    expect(existsSync(join(home, 'builds', 'early.txt'))).toBe(false)

    const page = await openWorkspacePage(win, 'Files')
    const writable = page.getByRole('group', { name: 'Writable folders' })
    await expect(writable).toContainText(join(home, 'project'))
    await addToList(page, 'Writable folders', '~/builds')
    await win.keyboard.press('Escape')

    await restartShell(win, 'rw')
    await runInTerminal(win, `echo built > ${home}/builds/out.txt && echo AFTER-$((2+2))`)
    await expect(rows).toContainText('AFTER-4', { timeout: 15_000 })
    expect(readFileSync(join(home, 'builds', 'out.txt'), 'utf8')).toBe('built\n')
  } finally {
    await app.close()
  }
})

test('a tool-folder preset switched on in Settings makes the tool readable once the shell restarts', async () => {
  test.setTimeout(120_000)
  const { app, win, home } = await launch()
  try {
    mkdirSync(join(home, '.bun', 'bin'), { recursive: true })
    writeFileSync(join(home, '.bun', 'bin', 'bun'), 'BUN-BINARY-STANDIN')
    await sandboxedShell(win)
    const rows = win.locator('.xterm-rows').first()
    await runInTerminal(win, 'cat ~/.bun/bin/bun; echo BEFORE-$((1+1))')
    await expect(rows).toContainText('BEFORE-2', { timeout: 15_000 })
    await expect(rows).not.toContainText('BUN-BINARY-STANDIN')

    const page = await openWorkspacePage(win, 'Files')
    const presets = page.getByRole('group', { name: 'Tool folders' })
    await expect(presets.getByRole('group', { name: 'Bun' })).toContainText('~/.bun')
    await expect(presets.getByRole('group', { name: 'Deno' })).toHaveCount(0)
    await presets.getByRole('group', { name: 'Bun' }).getByRole('switch').click()
    const readable = page.getByRole('group', { name: 'Readable folders' })
    await expect(readable.getByRole('button', { name: 'Remove ~/.bun' })).toBeVisible()
    await expect(readable.getByRole('listitem').filter({ hasText: '~/.bun' })).toContainText('Bun')
    await win.keyboard.press('Escape')

    await restartShell(win, 'preset')
    await runInTerminal(win, 'cat ~/.bun/bin/bun; echo AFTER-$((2+2))')
    await expect(rows).toContainText('AFTER-4', { timeout: 15_000 })
    await expect(rows).toContainText('BUN-BINARY-STANDIN')
  } finally {
    await app.close()
  }
})

test('tells a sandboxed shell that its home folder is hidden and that files written there are discarded', async () => {
  test.skip(process.platform !== 'linux', 'the hidden-home notice is shown only on Linux')
  test.setTimeout(120_000)
  const { app, win, home } = await launch()
  try {
    await sandboxedShell(win)
    const rows = win.locator('.xterm-rows').first()
    await expect(rows).toContainText('your home folder is hidden here')
    await expect(rows).toContainText('are discarded when this shell exits')
    await runInTerminal(win, 'echo kept > ~/lost.txt && cat ~/lost.txt && echo WROTE-$((3+3))')
    await expect(rows).toContainText('WROTE-6', { timeout: 15_000 })
    expect(existsSync(join(home, 'lost.txt'))).toBe(false)
  } finally {
    await app.close()
  }
})

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

test('a path hidden in Settings cannot be read from the sandbox, even inside the workspace folder', async () => {
  test.setTimeout(120_000)
  const { app, win, project } = await launch()
  try {
    mkdirSync(join(project, 'secrets'))
    writeFileSync(join(project, 'secrets', 'token.txt'), 'WORKSPACE-TOKEN-VALUE')
    await sandboxedShell(win)
    const rows = win.locator('.xterm-rows').first()
    await runInTerminal(win, 'cat secrets/token.txt')
    await expect(rows).toContainText('WORKSPACE-TOKEN-VALUE', { timeout: 15_000 })
    await runInTerminal(win, 'clear')
    await expect(rows).not.toContainText('WORKSPACE-TOKEN-VALUE')

    const page = await openWorkspacePage(win, 'Files')
    await addToList(page, 'Hidden paths', join(project, 'secrets'))
    await win.keyboard.press('Escape')

    await restartShell(win, 'hid')
    await runInTerminal(win, 'cat secrets/token.txt || echo HIDDEN-$((3+3))')
    await expect(rows).toContainText('HIDDEN-6', { timeout: 15_000 })
    await expect(rows).not.toContainText('WORKSPACE-TOKEN-VALUE')
  } finally {
    await app.close()
  }
})

test('a refused connection shows up under Blocked with its host, and Clear empties the list', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch()
  try {
    await sandboxedShell(win)
    const page = await openWorkspacePage(win, 'Network')
    await page
      .getByRole('group', { name: 'Never ask about other domains' })
      .getByRole('switch')
      .click()
    await win.keyboard.press('Escape')
    await expect(win.getByRole('button', { name: 'Restart to apply' })).toHaveCount(0)

    const rows = win.locator('.xterm-rows').first()
    await runInTerminal(
      win,
      'curl -s -m 10 -o /dev/null http://unlisted.invalid/; echo CURL-$((5+5))',
    )
    await expect(rows).toContainText('CURL-10', { timeout: 20_000 })
    await expect(win.getByRole('region', { name: 'Agent permission request' })).toHaveCount(0)

    const blocked = await openWorkspacePage(win, 'Blocked')
    const list = blocked.getByRole('list', { name: 'Blocked' })
    const row = list.getByRole('listitem').filter({ hasText: 'unlisted.invalid:80' })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toContainText('Network')
    await expect(row).toContainText('Not on the allowed list')
    await expect(row.getByRole('button', { name: 'Allow' })).toBeVisible()
    await blocked.getByRole('button', { name: 'Clear' }).click()
    await expect(blocked.getByRole('tabpanel', { name: 'Blocked' })).toContainText(
      'Nothing was blocked.',
    )
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

test('refuses to sandbox a workspace whose folder is the home folder, says why, and leaves the shell alone', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launchOptions, env: { ...launchOptions.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    await runInTerminal(win, 'echo ALIVE-$((6*7))')
    await expect(rows).toContainText('ALIVE-42', { timeout: 15_000 })

    await win.locator('.rail-row').first().click({ button: 'right' })
    await win.getByRole('menuitemcheckbox', { name: 'Sandbox' }).click()
    const dialog = win.getByRole('dialog')
    await expect(dialog).toContainText('This folder cannot be sandboxed', { timeout: 10_000 })
    await expect(dialog).toContainText(`${home} is your home folder`)
    await expect(dialog).toContainText('Open a project folder')
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toHaveCount(0)

    await expect(win.getByRole('button', { name: 'Restart to apply' })).toHaveCount(0)
    await win.locator('.rail-row').first().click({ button: 'right' })
    await expect(win.getByRole('menuitemcheckbox', { name: 'Sandbox' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    await win.keyboard.press('Escape')
    await runInTerminal(win, 'echo "still=${HTTPS_PROXY:-unsandboxed}"')
    await expect(rows).toContainText('still=unsandboxed', { timeout: 15_000 })
    await expect(rows).not.toContainText('process exited')
    await expect(rows).not.toContainText('chdir')
  } finally {
    await app.close()
  }
})
