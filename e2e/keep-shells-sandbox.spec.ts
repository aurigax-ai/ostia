import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { PRODUCT_NAME } from '../src/shared/product'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'

test.skip(process.platform !== 'linux', 'sandboxed kept shells are exercised on Linux')

interface Launched {
  app: ElectronApplication
  win: Page
}

let dataHome: string
let home: string
let extraEnv: Record<string, string> = {}

async function launch(): Promise<Launched> {
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...options,
    env: { ...options.env, HOME: home, ...extraEnv },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

async function quit(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {})
  await app.close().catch(() => {})
}

async function restart({ app, win }: Launched): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    electronApp.relaunch = () => undefined
  })
  const closed = app.waitForEvent('close')
  await win.evaluate(() => {
    void window.ostia.update.restart()
  })
  await closed
}

async function run(win: Page, command: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

function screen(win: Page) {
  return win.locator('.xterm-rows').first()
}

async function sandboxedShell(win: Page): Promise<void> {
  await win.locator('.rail-row').first().click({ button: 'right' })
  await win.getByRole('menuitemcheckbox', { name: 'Sandbox' }).click()
  const restartShell = win.getByRole('button', { name: 'Restart to apply' })
  await restartShell.click()
  await expect(restartShell).toHaveCount(0)
  await expect(async () => {
    await run(win, 'echo sandbox=${HTTPS_PROXY:+on}')
    await expect(screen(win)).toContainText('sandbox=on', { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

async function fakeUpstream(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('UPSTREAM-REACHED')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}` }
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function card(win: Page) {
  return win.getByRole('region', { name: 'Agent permission request' })
}

async function proxied(): Promise<Server> {
  const upstream = await fakeUpstream()
  extraEnv = { HTTP_PROXY: upstream.url, http_proxy: upstream.url, NO_PROXY: '', no_proxy: '' }
  return upstream.server
}

test.beforeEach(() => {
  dataHome = freshDataHome()
  home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  extraEnv = {}
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    terminal: { keepShells: true },
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
  })
})

test('KSH-C50 a sandboxed shell reaching an allowed domain keeps working across Restart', async () => {
  test.setTimeout(120_000)
  const upstream = await proxied()
  const first = await launch()
  try {
    await openWorkspace(first.win)
    await sandboxedShell(first.win)
    await run(
      first.win,
      'curl -s -m 30 -o /dev/null -w "first=%{http_code}\\n" http://kept.ostia-e2e.test/a',
    )
    await card(first.win).getByRole('button', { name: 'Allow for this workspace' }).click()
    await expect(screen(first.win)).toContainText('first=200', { timeout: 30_000 })
    await run(
      first.win,
      'clear; for i in $(seq 1 40); do curl -s -m 5 -o /dev/null -w "n$i=%{http_code} " http://kept.ostia-e2e.test/b; sleep 0.5; done',
    )
    await expect(screen(first.win)).toContainText('n2=200', { timeout: 15_000 })
    await restart(first)

    const second = await launch()
    try {
      await expect(screen(second.win)).toContainText(/n(1\d|2\d)=200/, { timeout: 30_000 })
      await expect(screen(second.win)).toContainText('n30=200', { timeout: 30_000 })
    } finally {
      await quit(second.app)
    }
  } finally {
    upstream.close()
  }
})

test('KSH-C51 a request to a new domain made while Ostia is closed shows its card once Ostia is back', async () => {
  test.setTimeout(120_000)
  const upstream = await proxied()
  const first = await launch()
  try {
    await openWorkspace(first.win)
    await sandboxedShell(first.win)
    await run(
      first.win,
      'sleep 3; curl -s -m 90 -o /dev/null -w "later=%{http_code}\\n" http://later.ostia-e2e.test/x',
    )
    await restart(first)
    await new Promise((r) => setTimeout(r, 5000))

    const second = await launch()
    try {
      await expect(card(second.win)).toContainText('later.ostia-e2e.test', { timeout: 30_000 })
      await card(second.win).getByRole('button', { name: 'Allow for this workspace' }).click()
      await expect(screen(second.win)).toContainText('later=200', { timeout: 30_000 })
    } finally {
      await quit(second.app)
    }
  } finally {
    upstream.close()
  }
})

test('KSH-C56 a kept sandbox keeps its temp folder across a restart', async () => {
  test.setTimeout(90_000)
  const first = await launch()
  await openWorkspace(first.win)
  await sandboxedShell(first.win)
  await run(first.win, 'touch "$TMPDIR/kept-marker" && echo marked-$((1+1))')
  await expect(screen(first.win)).toContainText('marked-2', { timeout: 15_000 })
  await restart(first)

  const second = await launch()
  try {
    await expect(screen(second.win)).toContainText(PROMPT, { timeout: 30_000 })
    await run(second.win, 'clear; [ -f "$TMPDIR/kept-marker" ] && echo tmp-$((2+2))')
    await expect(screen(second.win)).toContainText('tmp-4', { timeout: 15_000 })
  } finally {
    await quit(second.app)
  }
})

test('KSH-C58 an exposed port answers again after a restart without a new approval', async () => {
  test.setTimeout(150_000)
  const port = await freePort()
  const first = await launch()
  await openWorkspace(first.win)
  await sandboxedShell(first.win)
  await run(first.win, `ostia sandbox expose ${port}`)
  await card(first.win).getByRole('button', { name: 'Allow for this workspace' }).click()
  await expect(screen(first.win)).toContainText(`exposed: 127.0.0.1:${port}`, { timeout: 15_000 })
  const script = `require("http").createServer((q,r)=>r.end("INSIDE-C58")).listen(${port},"127.0.0.1")`
  await run(first.win, `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" -e '${script}' &`)
  await expect(async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('INSIDE-C58')
  }).toPass({ timeout: 30_000 })
  await restart(first)

  const second = await launch()
  try {
    await expect(screen(second.win)).toContainText(PROMPT, { timeout: 30_000 })
    await expect(async () => {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('INSIDE-C58')
    }).toPass({ timeout: 30_000 })
    await expect(card(second.win)).toHaveCount(0)
  } finally {
    await quit(second.app)
  }
})

test('KSH-C61 no socket a sandboxed shell can see is its sandbox host', async () => {
  test.setTimeout(90_000)
  const first = await launch()
  try {
    await openWorkspace(first.win)
    await sandboxedShell(first.win)
    const tmuxDir = join(tmpdir(), `${PRODUCT_NAME}-tmux-${process.getuid?.() ?? 0}`)
    const name = createHash('sha256').update(join(dataHome, 'userData')).digest('hex').slice(0, 16)
    await run(
      first.win,
      `echo "host-in-tmp=$(find "$TMPDIR" -type s -name '*host*' 2>/dev/null | wc -l)"; ls ${tmuxDir} 2>/dev/null | grep -c ${name} | sed 's/^/host-seen=/'`,
    )
    await expect(screen(first.win)).toContainText('host-in-tmp=0', { timeout: 15_000 })
    await expect(screen(first.win)).toContainText('host-seen=0')
  } finally {
    await quit(first.app)
  }
})
