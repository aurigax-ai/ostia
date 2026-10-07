import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Page, _electron as electron, expect, test } from './test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

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

test('MGR-C22 Ctrl+\\ detaches, the manager keeps running, and the next ostia <agent> reattaches', async () => {
  test.setTimeout(90_000)
  const { app, win, home, portal } = await launchOstia()
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

test('MGR-C11 an ostia <agent> run from an Ostia pane is refused even with the socket variables unset', async () => {
  test.setTimeout(90_000)
  const { app, win } = await launchOstia()
  try {
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await win.keyboard.type(
      'env -u OSTIA_SOCKET -u OSTIA_TOKEN -u OSTIA_SOCKET -u OSTIA_TOKEN ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" fake',
    )
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows').first()).toContainText('inside-ostia', {
      timeout: 20_000,
    })
    await expect(win.locator('.rail-tab', { hasText: 'Manager' })).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

const OSTIA_FN = 'P() { ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" "$@"; }\r'

async function spawnWorker(mirror: Mirror): Promise<string> {
  mirror.type(OSTIA_FN)
  mirror.type('P manager spawn fake --name worker-one -- hello\r')
  await expect.poll(mirror.output, { timeout: 20_000 }).toMatch(/"paneId":"[0-9a-f-]{36}"/)
  const id = /"paneId":"([0-9a-f-]{36})"/.exec(mirror.output())?.[1]
  if (!id) throw new Error('no worker pane id')
  return id
}

test('MGR-C29 the manager starts a worker in its own workspace and reads its screen', async () => {
  test.setTimeout(90_000)
  const { app, win, home, portal } = await launchOstia()
  const mirror = runMirror(portal, home, ['sh'])
  try {
    await expect(win.locator('.rail-tab', { hasText: 'Manager · sh' })).toBeVisible({
      timeout: 20_000,
    })
    const worker = await spawnWorker(mirror)
    const tab = win.locator('.rail-tab', { hasText: 'worker-one' })
    await expect(tab).toBeVisible({ timeout: 20_000 })
    await tab.click()
    await expect(win.locator('.xterm-rows:visible').first()).toContainText('agent ready hello', {
      timeout: 20_000,
    })

    mirror.type(`P manager read ${worker} --lines 5 | tr a-z A-Z\r`)
    await expect.poll(mirror.output, { timeout: 10_000 }).toContain('AGENT READY HELLO')

    mirror.type(`P manager input ${worker} --text ping --key enter\r`)
    await expect.poll(mirror.output, { timeout: 10_000 }).toContain('input-off')

    mirror.type('P docs | grep -c "manager spawn"\r')
    await expect.poll(mirror.output, { timeout: 10_000 }).toMatch(/[\n\r]1\r*\n/)
  } finally {
    mirror.child.kill()
    await app.close().catch(() => {})
  }
})

test('MGR-C35 with typing allowed, the manager answers a worker', async () => {
  test.setTimeout(90_000)
  const { app, win, home, portal } = await launchOstia({ allowInput: true })
  const mirror = runMirror(portal, home, ['sh'])
  try {
    const worker = await spawnWorker(mirror)
    const tab = win.locator('.rail-tab', { hasText: 'worker-one' })
    await expect(tab).toBeVisible({ timeout: 20_000 })
    await tab.click()
    const screen = win.locator('.xterm-rows:visible').first()
    await expect(screen).toContainText('agent ready hello', { timeout: 20_000 })

    mirror.type(`P manager input ${worker} --text ping --key enter\r`)
    await expect(screen).toContainText('got ping', { timeout: 10_000 })
  } finally {
    mirror.child.kill()
    await app.close().catch(() => {})
  }
})

test('MGR-C31 a worker pane cannot call the manager verbs', async () => {
  test.setTimeout(90_000)
  const { app, win } = await launchOstia()
  try {
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await win.keyboard.type('ostia manager read x; ostia docs | grep -c "manager spawn"')
    await win.keyboard.press('Enter')
    const screen = win.locator('.xterm-rows').first()
    await expect(screen).toContainText(/not-available-to-pane\s*0/, { timeout: 20_000 })
  } finally {
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
