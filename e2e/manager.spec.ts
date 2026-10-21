import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { _electron as electron, expect, type Page, test } from './test'

const CLI = resolve('out/cli/index.js')
const FAKE_AGENT_BIN = resolve('test/fixtures/manager/bin')

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function launchOstia(manager: object = {}, settings: object = {}) {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    manager: {
      agents: { fake: ['fake-agent'], sh: ['bash', '--norc', '--noprofile'] },
      ...manager,
    },
    ...settings,
  })
  const portal = join(dataHome, 'portal.sock')
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launchOptions,
    env: {
      ...launchOptions.env,
      HOME: home,
      OSTIA_PORTAL_SOCKET: portal,
      PATH: `${FAKE_AGENT_BIN}:${process.env.PATH ?? ''}`,
    },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win, home, portal }
}

function outsideEnv(portal: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      key.startsWith('OSTIA_') ||
      key.startsWith('OSTIA_') ||
      key === 'ELECTRON_RUN_AS_NODE'
    )
      continue
    env[key] = value
  }
  return {
    ...env,
    OSTIA_PORTAL_SOCKET: portal,
    PATH: `${FAKE_AGENT_BIN}:${process.env.PATH ?? ''}`,
  }
}

interface Mirror {
  child: ChildProcess
  output: () => string
  exited: Promise<number | null>
  type: (text: string) => void
}

function runMirror(portal: string, cwd: string, args: string[]): Mirror {
  const command = [process.execPath, CLI, ...args].map(shellQuote).join(' ')
  const child = spawn('script', ['-qfec', command, '/dev/null'], {
    cwd,
    env: outsideEnv(portal),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  child.stderr?.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  return {
    child,
    output: () => out,
    exited: new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code))),
    type: (text) => child.stdin?.write(text),
  }
}

function managerView(win: Page) {
  return win.locator('.manager-host .xterm-rows')
}

test('MGR-C21 ostia <agent> from outside mirrors a read-only manager and passes its exit code', async () => {
  test.setTimeout(90_000)
  const { app, win, home, portal } = await launchOstia()
  const mirror = runMirror(portal, home, ['fake', 'hello-arg'])
  try {
    await expect.poll(mirror.output, { timeout: 20_000 }).toContain('agent ready hello-arg')
    await expect(win.locator('.rail-tab', { hasText: 'Manager · fake' })).toBeVisible()
    await expect(managerView(win)).toContainText('agent ready hello-arg')

    await win.locator('.manager-host').click()
    await win.keyboard.type('zzz')
    await expect(win.getByRole('status').filter({ hasText: 'Read-only' })).toBeVisible()
    mirror.type('ping\r')
    await expect.poll(mirror.output).toContain('got ping')
    await expect(managerView(win)).toContainText('got ping')
    expect(mirror.output()).not.toContain('zzz')

    mirror.type('quit\r')
    expect(await mirror.exited).toBe(7)
    await expect(
      win.getByRole('status').filter({ hasText: 'The manager has ended.' }),
    ).toBeVisible()
  } finally {
    mirror.child.kill()
    await app.close().catch(() => {})
  }
})

test('KSH-C42 the manager never runs in tmux, even with Keep shells running on', async () => {
  test.setTimeout(90_000)
  const { app, home, portal } = await launchOstia({}, { terminal: { keepShells: true } })
  const mirror = runMirror(portal, home, ['sh'])
  try {
    mirror.type('echo "parent=$(ps -o comm= -p $PPID) tmux=${TMUX-none}"\r')
    await expect.poll(mirror.output, { timeout: 20_000 }).toMatch(/parent=\S+ tmux=none/)
    expect(mirror.output()).not.toMatch(/parent=tmux/)
  } finally {
    mirror.child.kill()
    await app.close().catch(() => {})
  }
})
