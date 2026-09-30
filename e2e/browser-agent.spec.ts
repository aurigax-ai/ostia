import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

const CLI = resolve(__dirname, '../out/cli/index.js')

const PAGE = `<!doctype html>
<html><head><title>Agent fixture</title></head>
<body>
  <h1>Shop</h1>
  <form onsubmit="event.preventDefault()">
    <label for="name">Name</label><input id="name">
    <label for="note">Note</label><input id="note" value="a">
    <label><input id="agree" type="checkbox"> I agree</label>
    <select id="size" aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>
    <button type="button" id="greet" onclick="document.getElementById('greeting').textContent = 'Hello, ' + document.getElementById('name').value">Greet</button>
  </form>
  <p id="greeting"></p>
  <a href="/next">Next page</a>
  <script>localStorage.setItem('theme', 'dark'); fetch('/api/ping')</script>
</body></html>`

interface Response {
  success: boolean
  data: Record<string, unknown> | null
  error: string | null
}

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"pong":true}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(req.url === '/next' ? '<title>Next</title><h1>Next</h1>' : PAGE)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

function readPaneEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

test('an agent drives the in-app browser with the agent-browser command contract', async () => {
  test.setTimeout(180_000)
  const server = await serve()
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, capabilities: { grants: ['browse'] } })
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    const envFile = join(dataHome, 'pane.env')
    await win.locator('.xterm').first().click()
    await win.keyboard.type(`env | grep '^PINE_' > ${envFile}`)
    await win.keyboard.press('Enter')
    await expect
      .poll(() => existsSync(envFile) && readFileSync(envFile, 'utf8'))
      .toContain('PINE_TOKEN=')
    const paneEnv = readPaneEnv(envFile)

    const pine = (...args: string[]): Promise<{ code: number; out: string; err: string }> =>
      new Promise((done, fail) => {
        const child = spawn(process.execPath, [CLI, 'browse', ...args], {
          env: {
            ...process.env,
            PINE_SOCKET: paneEnv.PINE_SOCKET,
            PINE_TOKEN: paneEnv.PINE_TOKEN,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (c: Buffer) => {
          out += c.toString()
        })
        child.stderr.on('data', (c: Buffer) => {
          err += c.toString()
        })
        child.on('error', fail)
        child.on('close', (code) => done({ code: code ?? 1, out: out.trim(), err: err.trim() }))
      })
    const json = async (...args: string[]): Promise<Response> => {
      const res = await pine(...args, '--json')
      return JSON.parse(res.out) as Response
    }

    const opened = await json('open', `${origin}/`)
    expect(opened.success).toBe(true)
    expect(opened.data?.tabId).toEqual(expect.any(String))
    expect((await json('wait', '--load', 'load')).success).toBe(true)
    await expect.poll(async () => (await pine('get', 'title')).out).toBe('Agent fixture')

    const snap = await json('snapshot', '-i')
    expect(snap.success).toBe(true)
    const snapshot = String(snap.data?.snapshot)
    expect(snapshot).toMatch(/- textbox "Name" \[ref=e\d+\]/)
    expect(snapshot).toMatch(/- button "Greet" \[ref=e\d+\]/)
    expect(snapshot).toMatch(/- link "Next page" \[ref=e\d+\]/)
    expect(snapshot).not.toContain('heading')
    const refOf = (pattern: RegExp): string => `@${(snapshot.match(pattern) ?? [])[1]}`
    const nameRef = refOf(/textbox "Name" \[ref=(e\d+)\]/)
    const greetRef = refOf(/button "Greet" \[ref=(e\d+)\]/)

    const full = await pine('snapshot')
    expect(full.out).toMatch(/- heading "Shop" \[ref=e\d+\] \[level=1\]/)
    expect(full.out).toContain(`[ref=${nameRef.slice(1)}]`)

    expect((await pine('fill', nameRef, 'Ada')).code).toBe(0)
    expect((await pine('click', greetRef)).code).toBe(0)
    await expect.poll(async () => (await pine('get', 'text', '#greeting')).out).toBe('Hello, Ada')

    expect((await pine('type', '#note', 'bc')).code).toBe(0)
    await expect.poll(async () => (await pine('get', 'value', '#note')).out).toBe('abc')

    expect((await pine('check', '#agree')).code).toBe(0)
    expect((await pine('is', 'checked', '#agree')).out).toBe('true')
    expect((await pine('select', '#size', 'Large')).code).toBe(0)
    expect((await pine('get', 'value', '#size')).out).toBe('l')

    expect((await pine('find', 'label', 'Name', 'fill', 'Grace')).code).toBe(0)
    expect((await pine('find', 'role', 'button', 'click', '--name', 'Greet')).code).toBe(0)
    await expect.poll(async () => (await pine('get', 'text', '#greeting')).out).toBe('Hello, Grace')

    const title = await json('eval', 'document.title')
    expect(title).toEqual({ success: true, data: { result: 'Agent fixture' }, error: null })

    const local = await json('storage', 'local')
    expect(local.data?.values).toEqual({ theme: 'dark' })
    expect((await pine('cookies', 'set', 'flavor', 'oat')).code).toBe(0)
    const cookies = await json('cookies')
    expect(cookies.data?.cookies).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'flavor', value: 'oat' })]),
    )

    const requests = await pine('network', 'requests', '--filter', '/api/ping')
    expect(requests.out).toMatch(/GET\t200\t\w+\thttp:\/\/127\.0\.0\.1:\d+\/api\/ping/)

    const tabs = await json('tab')
    expect(tabs.data?.tabs).toEqual([
      expect.objectContaining({ tabId: opened.data?.tabId, title: 'Agent fixture', active: true }),
    ])

    const shot = await pine('screenshot')
    expect(shot.code).toBe(0)
    expect(existsSync(shot.out)).toBe(true)

    const missing = await json('click', '@e999')
    expect(missing.success).toBe(false)
    expect(missing.error).toMatch(/^not-found/)

    expect((await pine('click', 'text=Next page')).code).toBe(0)
    expect((await json('wait', '--url', '**/next')).success).toBe(true)
    expect((await pine('back')).code).toBe(0)
    await expect.poll(async () => (await pine('get', 'url')).out).toBe(`${origin}/`)
  } finally {
    await app.close()
    server.close()
  }
})
