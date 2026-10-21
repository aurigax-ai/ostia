import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, seedSettings } from './dataHome'
import { launchWindow, openWorkspace, quitApp, readPaneEnv } from './helpers'
import { type Page, expect, test } from './test'

const CLI = resolve(__dirname, '../out/cli/index.js')
const COOKIE = 'ostia_profile=kept'

interface Seen {
  path: string
  cookie: string
}

function serve(seen: Seen[]): Promise<Server> {
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    seen.push({ path, cookie: req.headers.cookie ?? '' })
    if (path === '/set') res.setHeader('set-cookie', `${COOKIE}; Max-Age=3600; Path=/`)
    res.setHeader('content-type', 'text/html')
    res.end(`<title>profile ${path}</title><p>${path}</p>`)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

interface Run {
  code: number
  out: string
  err: string
}

function runCli(
  env: Record<string, string>,
  args: string[],
): { child: ChildProcess; done: Promise<Run> } {
  const child = spawn(process.execPath, [CLI, 'browse', ...args], {
    env: { ...process.env, OSTIA_SOCKET: env.OSTIA_SOCKET, OSTIA_TOKEN: env.OSTIA_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString()
  })
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString()
  })
  const done = new Promise<Run>((ok, fail) => {
    child.on('error', fail)
    child.on('close', (code) => ok({ code: code ?? 1, out: out.trim(), err: err.trim() }))
  })
  return { child, done }
}

async function openHumanTab(win: Page, url: string): Promise<void> {
  await win.getByRole('button', { name: 'New browser tab' }).first().click()
  const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
  await expect(address).toBeVisible({ timeout: 15_000 })
  await address.fill(url)
  await address.press('Enter')
}

const visited = (seen: Seen[], path: string): Seen | undefined => seen.find((s) => s.path === path)

test('the human’s browser panes share one profile that survives a restart, and an agent’s pane does not see it', async () => {
  test.setTimeout(240_000)
  const seen: Seen[] = []
  const server = await serve(seen)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, capabilities: { grants: ['browse'] } })

  const first = await launchWindow(dataHome)
  try {
    const { win } = first
    await openWorkspace(win)
    const envFile = join(dataHome, 'pane.env')
    await win.locator('.xterm').first().click()
    await win.keyboard.type(`env | grep '^OSTIA_' > ${envFile}`)
    await win.keyboard.press('Enter')
    await expect
      .poll(() => existsSync(envFile) && readFileSync(envFile, 'utf8'))
      .toContain('OSTIA_TOKEN=')
    const paneEnv = readPaneEnv(envFile)

    await openHumanTab(win, `${origin}/set`)
    await expect.poll(() => visited(seen, '/set'), { timeout: 15_000 }).toBeTruthy()

    await openHumanTab(win, `${origin}/echo`)
    await expect.poll(() => visited(seen, '/echo')?.cookie, { timeout: 15_000 }).toBe(COOKIE)

    const opened = await runCli(paneEnv, ['open', `${origin}/agent`, '--json']).done
    expect(JSON.parse(opened.out).success).toBe(true)
    await expect.poll(() => visited(seen, '/agent'), { timeout: 15_000 }).toBeTruthy()
    expect(visited(seen, '/agent')?.cookie).toBe('')
  } finally {
    await quitApp(first.app)
  }

  seen.length = 0
  const second = await launchWindow(dataHome)
  try {
    await expect.poll(() => visited(seen, '/echo')?.cookie, { timeout: 30_000 }).toBe(COOKIE)
    await expect.poll(() => visited(seen, '/agent'), { timeout: 30_000 }).toBeTruthy()
    expect(visited(seen, '/agent')?.cookie).toBe('')
  } finally {
    await quitApp(second.app)
    server.close()
  }
})
