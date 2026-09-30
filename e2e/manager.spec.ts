import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

const CLI = resolve('out/cli/index.js')
const FAKE_AGENT_BIN = resolve('test/fixtures/manager/bin')

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function launchPine() {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    manager: { agents: { fake: ['fake-agent'] } },
  })
  const portal = join(dataHome, 'portal.sock')
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launchOptions,
    env: { ...launchOptions.env, HOME: home, PINE_PORTAL_SOCKET: portal },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win, home, portal }
}

function outsideEnv(portal: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('PINE_') || key === 'ELECTRON_RUN_AS_NODE') continue
    env[key] = value
  }
  return {
    ...env,
    PINE_PORTAL_SOCKET: portal,
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

test('MGR-C21 pine <agent> from outside mirrors a read-only manager and passes its exit code', async () => {
  test.setTimeout(90_000)
  const { app, win, home, portal } = await launchPine()
  const mirror = runMirror(portal, home, ['fake', 'hello-arg'])
  try {
    await expect.poll(mirror.output, { timeout: 20_000 }).toContain('agent ready hello-arg')
    await expect(win.locator('.rail-tab', { hasText: 'Manager · fake' })).toBeVisible()
    await expect(managerView(win)).toContainText('agent ready hello-arg')
    await expect(win.locator('.manager-notice')).toContainText('Read-only')

    await win.locator('.manager-host').click()
    await win.keyboard.type('zzz')
    mirror.type('ping\r')
    await expect.poll(mirror.output).toContain('got ping')
    await expect(managerView(win)).toContainText('got ping')
    expect(mirror.output()).not.toContain('zzz')

    mirror.type('quit\r')
    expect(await mirror.exited).toBe(7)
    await expect(win.locator('.manager-notice')).toContainText('The manager has ended.')
  } finally {
    mirror.child.kill()
    await app.close().catch(() => {})
  }
})

test('MGR-C22 Ctrl+\\ detaches, the manager keeps running, and the next pine <agent> reattaches', async () => {
  test.setTimeout(90_000)
  const { app, win, home, portal } = await launchPine()
  const first = runMirror(portal, home, ['fake'])
  let second: Mirror | null = null
  try {
    await expect.poll(first.output, { timeout: 20_000 }).toContain('agent ready')
    first.type('\x1c')
    expect(await first.exited).toBe(0)
    expect(first.output()).toContain('detached')

    second = runMirror(portal, home, ['fake'])
    await expect.poll(second.output, { timeout: 20_000 }).toContain('agent ready')
    second.type('again\r')
    await expect.poll(second.output).toContain('got again')
    await expect(win.locator('.rail-tab', { hasText: 'Manager · fake' })).toHaveCount(1)

    const other = runMirror(portal, home, ['codex'])
    expect(await other.exited).toBe(1)
    expect(other.output()).toMatch(/mirror-attached|manager-busy/)
  } finally {
    first.child.kill()
    second?.child.kill()
    await app.close().catch(() => {})
  }
})

test('MGR-C11 a pine <agent> run from a Pine pane is refused even with PINE_SOCKET unset', async () => {
  test.setTimeout(90_000)
  const { app, win } = await launchPine()
  try {
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await win.keyboard.type(
      'env -u PINE_SOCKET -u PINE_TOKEN ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" fake',
    )
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows').first()).toContainText('inside-pine', {
      timeout: 20_000,
    })
    await expect(win.locator('.rail-tab', { hasText: 'Manager' })).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})
