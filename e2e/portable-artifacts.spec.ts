import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin, startFakeAgent } from './fakeAgent'
import { expectHeld, launchWindow, openWorkspace, runInTerminal } from './helpers'
import {
  type Browser,
  type BrowserContext,
  type BrowserType,
  chromium,
  type ElectronApplication,
  _electron as electron,
  expect,
  type FrameLocator,
  firefox,
  type Page,
  test,
} from './test'
import { viewerGuestText } from './viewerGuest'

const PREVIEW_URL = 'ostia-preview://'
const BROWSERS: ReadonlyArray<[string, BrowserType]> = [
  ['chromium', chromium],
  ['firefox', firefox],
]

interface Listener {
  port: number
  hits: () => number
  close: () => Promise<void>
}

async function listen(body = 'ok'): Promise<Listener> {
  let hits = 0
  const sockets = new Set<Socket>()
  const tcp: Server = createServer((socket) => {
    hits += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.end(
      `HTTP/1.1 200 OK\r\ncontent-type: text/javascript\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
    )
  })
  await new Promise<void>((ok) => tcp.listen(0, '127.0.0.1', ok))
  return {
    port: (tcp.address() as AddressInfo).port,
    hits: () => hits,
    close: () =>
      new Promise<void>((ok) => {
        for (const socket of sockets) socket.destroy()
        tcp.close(() => ok())
      }),
  }
}

async function launch(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, editor: { openFilesIn: 'split' } })
  const launched = await launchWindow(dataHome)
  await openWorkspace(launched.win)
  return launched
}

function home(dataHome: string): string {
  const dir = join(dataHome, 'home', 'made')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function openArtifact(win: Page, name: string): Promise<void> {
  await runInTerminal(
    win,
    `cp ~/made/${name} "$OSTIA_ARTIFACTS/" && ostia open "$OSTIA_ARTIFACTS/${name}"`,
  )
  await expect(win.locator('.pane-header', { hasText: name })).toBeVisible({ timeout: 20_000 })
}

async function savePortable(
  app: ElectronApplication,
  win: Page,
  name: string,
  target: string,
): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath,
    })) as typeof dialog.showSaveDialog
  }, target)
  const header = win.locator('.pane-header', { hasText: name })
  await header.getByRole('button', { name: 'More ways to take this file' }).click()
  await win.getByRole('menuitem', { name: 'Save Portable File…' }).click()
  await expect.poll(() => existsSync(target), { timeout: 30_000 }).toBe(true)
}

const launchedBrowsers = new Map<string, Browser>()

test.afterAll(async () => {
  const open = [...launchedBrowsers.values()]
  launchedBrowsers.clear()
  await Promise.all(open.map((browser) => browser.close()))
})

async function browserOf(name: string, type: BrowserType): Promise<Browser> {
  const known = launchedBrowsers.get(name)
  if (known) return known
  const browser = await type.launch({ headless: true })
  launchedBrowsers.set(name, browser)
  return browser
}

async function inBrowsers(
  file: string,
  run: (frame: FrameLocator, page: Page, name: string, context: BrowserContext) => Promise<void>,
  options: { offline?: boolean; viewport?: { width: number; height: number } } = {},
): Promise<void> {
  for (const [name, type] of BROWSERS) {
    const browser = await browserOf(name, type)
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 900, height: 700 },
    })
    try {
      if (options.offline !== false) await context.setOffline(true)
      const page = (await context.newPage()) as unknown as Page
      await page.goto(pathToFileURL(file).href)
      await run(page.frameLocator('iframe'), page, name, context)
    } finally {
      await context.close()
    }
  }
}

function inGuest<T>(app: ElectronApplication, expression: string): Promise<T | null> {
  return app.evaluate(
    async ({ webContents }, [prefix, code]) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(prefix))
      return guest ? ((await guest.executeJavaScript(code)) as T) : null
    },
    [PREVIEW_URL, expression] as const,
  )
}

const CHART = `import { useState } from 'react'
import { Line, LineChart, XAxis } from 'recharts'
import { Check } from 'lucide-react'

const points = [
  { x: 1, y: 2 },
  { x: 2, y: 5 },
  { x: 3, y: 3 },
]

export default function Chart() {
  const [count, setCount] = useState(0)
  return (
    <div id="box" className="p-4 text-3xl font-bold">
      <button id="inc" onClick={() => setCount(count + 1)}>count {count}</button>
      <Check />
      <LineChart width={300} height={120} data={points}>
        <XAxis dataKey="x" />
        <Line dataKey="y" isAnimationActive={false} />
      </LineChart>
    </div>
  )
}
`

const PAGE = `<!doctype html>
<html><head><title>page</title></head>
<body><p id="out">waiting</p>
<script type="module">
import { scaleLinear } from 'd3'
document.getElementById('out').textContent = 'scaled ' + scaleLinear().domain([0, 1]).range([0, 10])(0.5)
</script>
</body></html>
`

const PLAN = `# Plan

Steps below.

\`\`\`mermaid
graph TD
  A[Start] --> B[Done]
\`\`\`

[docs](https://example.com/docs)
`

const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#3366ff"/></svg>'

const ESCAPES = `export default function Escapes() {
  const r: Record<string, string> = {}
  const tried = (name: string, run: () => unknown) => {
    try {
      const value = run()
      r[name] = value === undefined || value === null ? 'nothing' : String(value)
    } catch (e) {
      r[name] = 'threw'
    }
  }
  tried('storage', () => { localStorage.setItem('a', '1'); return 'stored' })
  tried('cookie', () => document.cookie)
  tried('open', () => window.open('http://127.0.0.1:__PORT__/popup'))
  tried('top', () => { top!.location.href = 'http://127.0.0.1:__PORT__/top'; return 'set' })
  tried('form', () => {
    const form = document.createElement('form')
    form.method = 'post'
    form.action = 'http://127.0.0.1:__PORT__/form'
    document.body.appendChild(form)
    form.submit()
    return 'submitted'
  })
  return <pre id="result">{JSON.stringify(r)}</pre>
}
`

const NAVIGATES = `<!doctype html>
<body>
<a id="link" href="http://127.0.0.1:__PORT__/y">a link</a>
<button id="go" onclick="location.href = 'http://127.0.0.1:__PORT__/x'">go</button>
</body>
`

test('PRT-C1 PRT-C4 PRT-C5 PRT-C6 a portable file of every type opens offline in Chromium and Firefox and works, cannot reach the network or leave its frame, and opens a Markdown link in a new tab', async () => {
  test.setTimeout(300_000)
  const dataHome = freshDataHome()
  const dir = home(dataHome)
  const outside = await listen()
  const target = await listen()
  const files: Record<string, string> = {
    'chart.tsx': CHART,
    'page.html': PAGE,
    'plan.md': PLAN,
    'logo.svg': LOGO,
    'rows.csv': 'name,count\nalpha,1\nbeta,2\n',
    'data.json': '{"answer":42,"list":[1,2]}',
    'escapes.tsx': ESCAPES.replaceAll('__PORT__', String(outside.port)),
    'navigates.html': NAVIGATES.replaceAll('__PORT__', String(outside.port)),
    'link.md': `# Plan\n\n[docs](http://127.0.0.1:${target.port}/docs)\n`,
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  const { app, win } = await launch(dataHome)
  const saved = join(dataHome, 'saved')
  mkdirSync(saved)
  const savedFile = (name: string): string => join(saved, `${name}.html`)
  try {
    for (const name of Object.keys(files)) {
      await openArtifact(win, name)
      if (name === 'rows.csv') {
        await expect
          .poll(() => viewerGuestText(app, { viewType: 'csv.table', name }), { timeout: 20_000 })
          .toContain('alpha')
      }
      await savePortable(app, win, name, savedFile(name))
    }
  } finally {
    await app.close()
  }
  try {
    await test.step('PRT-C1 every type opens offline and works', async () => {
      await inBrowsers(savedFile('chart.tsx'), async (frame, _page, name) => {
        await expect(frame.locator('#inc'), name).toHaveText('count 0', { timeout: 15_000 })
        await frame.locator('#inc').click()
        await expect(frame.locator('#inc'), name).toHaveText('count 1')
        await expect(frame.locator('svg.lucide'), name).toHaveCount(1)
        await expect(frame.locator('.recharts-line path'), name).toHaveCount(1)
        await expect(frame.locator('#box'), name).toHaveCSS('padding-top', '16px')
      })
      await inBrowsers(savedFile('page.html'), async (frame, _page, name) => {
        await expect(frame.locator('#out'), name).toHaveText('scaled 5', { timeout: 15_000 })
      })
      await inBrowsers(savedFile('plan.md'), async (frame, _page, name) => {
        await expect(frame.locator('h1'), name).toHaveText('Plan')
        const diagram = frame.locator('img.mermaid-diagram')
        await expect(diagram, name).toHaveCount(1)
        await expect
          .poll(() => diagram.evaluate((img: HTMLImageElement) => img.naturalWidth), {
            message: name,
          })
          .toBeGreaterThan(0)
      })
      await inBrowsers(savedFile('logo.svg'), async (frame, _page, name) => {
        await expect
          .poll(() => frame.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth), {
            message: name,
          })
          .toBe(40)
      })
      await inBrowsers(savedFile('rows.csv'), async (frame, _page, name) => {
        await expect(frame.locator('td'), name).toHaveCount(4)
        await expect(frame.locator('th').first(), name).toHaveText('name')
      })
      await inBrowsers(savedFile('data.json'), async (frame, _page, name) => {
        await expect(frame.locator('pre'), name).toContainText('"answer": 42')
      })
    })

    await test.step('PRT-C4 no storage, cookies, popups, top navigation or forms', async () => {
      await inBrowsers(
        savedFile('escapes.tsx'),
        async (frame, page, name, context) => {
          const text = await frame.locator('#result').textContent({ timeout: 15_000 })
          const r = JSON.parse(text ?? '{}') as Record<string, string>
          expect(r.storage, name).toBe('threw')
          expect(['threw', 'nothing', ''], name).toContain(r.cookie)
          expect(['threw', 'nothing'], name).toContain(r.open)
          expect(r.top, name).toBe('threw')
          await expectHeld(
            async () => [page.url(), context.pages().length],
            [pathToFileURL(savedFile('escapes.tsx')).href, 1],
            500,
            name,
          )
        },
        { offline: false },
      )
    })

    await test.step('PRT-C5 no navigation of the frame to the network by script or link', async () => {
      const navigates = savedFile('navigates.html')
      await inBrowsers(
        navigates,
        async (frame, page, name) => {
          for (const control of ['#go', '#link']) {
            await page.goto(pathToFileURL(navigates).href)
            await frame.locator(control).click({ timeout: 10_000 })
            await expectHeld(async () => outside.hits(), 0, 1_000, `${name} ${control}`)
          }
        },
        { offline: false },
      )
    })

    await test.step('PRT-C6 a Markdown link opens in a new tab and the file runs no script', async () => {
      await inBrowsers(
        savedFile('link.md'),
        async (frame, _page, name, context) => {
          await expect(frame.locator('script'), name).toHaveCount(0)
          const opened = context.waitForEvent('page', { timeout: 10_000 })
          await frame.getByRole('link', { name: 'docs' }).click()
          const tab = await opened
          await expect
            .poll(() => tab.url(), { message: name })
            .toBe(`http://127.0.0.1:${target.port}/docs`)
        },
        { offline: false },
      )
    })
    expect(outside.hits()).toBe(0)
  } finally {
    await outside.close()
    await target.close()
  }
})

test('PRT-C2 the Ostia preview and the portable file in Chromium look the same', async () => {
  test.setTimeout(240_000)
  const dataHome = freshDataHome()
  writeFileSync(join(home(dataHome), 'chart.tsx'), CHART)
  const saved = join(dataHome, 'chart.html')
  const { app, win } = await launch(dataHome)
  try {
    await openArtifact(win, 'chart.tsx')
    await expect
      .poll(() => inGuest<string>(app, "document.getElementById('inc')?.textContent ?? ''"), {
        timeout: 30_000,
      })
      .toBe('count 0')
    await savePortable(app, win, 'chart.tsx', saved)
    const shown = await inGuest<{ width: number; height: number; text: string; styles: string[] }>(
      app,
      `({ width: innerWidth, height: innerHeight, text: document.body.innerText,
         styles: ['padding-top', 'font-size', 'font-weight'].map((p) => getComputedStyle(document.getElementById('box')).getPropertyValue(p)) })`,
    )
    expect(shown).not.toBeNull()
    if (!shown) return
    const ostia = await app.evaluate(async ({ webContents }, prefix) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(prefix))
      return guest ? (await guest.capturePage()).toPNG().toString('base64') : null
    }, PREVIEW_URL)
    const browser = await chromium.launch({ headless: true })
    let other = ''
    try {
      const context = await browser.newContext({
        viewport: { width: shown.width, height: shown.height },
        deviceScaleFactor: 1,
      })
      await context.setOffline(true)
      const page = await context.newPage()
      await page.goto(pathToFileURL(saved).href)
      const frame = page.frameLocator('iframe')
      await expect(frame.locator('#inc')).toHaveText('count 0', { timeout: 15_000 })
      const seen = await frame.locator('body').evaluate((body: HTMLElement) => ({
        text: body.innerText,
        styles: ['padding-top', 'font-size', 'font-weight'].map((p) =>
          getComputedStyle(body.querySelector('#box') as Element).getPropertyValue(p),
        ),
      }))
      expect(seen).toEqual({ text: shown.text, styles: shown.styles })
      other = (await page.screenshot()).toString('base64')
    } finally {
      await browser.close()
    }
    const differing = await app.evaluate(
      ({ nativeImage }, [a, b]) => {
        const left = nativeImage.createFromBuffer(Buffer.from(a ?? '', 'base64'))
        const right = nativeImage.createFromBuffer(Buffer.from(b, 'base64')).resize(left.getSize())
        const x = left.toBitmap()
        const y = right.toBitmap()
        let off = 0
        for (let i = 0; i < x.length; i += 4) {
          const delta =
            Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2])
          if (delta > 48) off += 1
        }
        return off / (x.length / 4)
      },
      [ostia, other] as const,
    )
    expect(differing).toBeLessThanOrEqual(0.01)
  } finally {
    await app.close()
  }
})

const REFUSED = `import { useState } from 'react'
export default function Refused() {
  const [r, setR] = useState<Record<string, string>>({})
  const run = async () => {
    const out: Record<string, string> = {}
    try { out.eval = String(eval('1 + 1')) } catch { out.eval = 'threw' }
    try { out.fn = String(new Function('return 2')()) } catch { out.fn = 'threw' }
    try { await fetch('http://127.0.0.1:__PORT__/fetch', { mode: 'no-cors' }); out.fetch = 'reached' } catch { out.fetch = 'threw' }
    out.socket = await new Promise<string>((done) => {
      try {
        const socket = new WebSocket('ws://127.0.0.1:__PORT__/socket')
        socket.onopen = () => done('open')
        socket.onerror = () => done('failed')
      } catch { done('threw') }
    })
    setR(out)
  }
  return <div><button id="run" onClick={run}>run</button><pre id="result">{JSON.stringify(r)}</pre></div>
}
`

test('PRT-C22 eval, new Function, fetch and WebSocket are refused in the preview and in browsers', async () => {
  test.setTimeout(240_000)
  const dataHome = freshDataHome()
  const outside = await listen()
  writeFileSync(
    join(home(dataHome), 'refused.tsx'),
    REFUSED.replaceAll('__PORT__', String(outside.port)),
  )
  const saved = join(dataHome, 'refused.html')
  const refused = (text: string | null): boolean => {
    const r = JSON.parse(text || '{}') as Record<string, string>
    return (
      r.eval === 'threw' &&
      r.fn === 'threw' &&
      r.fetch === 'threw' &&
      ['failed', 'threw'].includes(r.socket)
    )
  }
  const { app, win } = await launch(dataHome)
  try {
    await openArtifact(win, 'refused.tsx')
    await expect
      .poll(() => inGuest<number>(app, "document.querySelectorAll('#run').length"), {
        timeout: 30_000,
      })
      .toBe(1)
    await inGuest(app, "document.getElementById('run').click(), 0")
    await expect
      .poll(
        async () =>
          refused(await inGuest<string>(app, "document.getElementById('result').textContent")),
        {
          timeout: 15_000,
        },
      )
      .toBe(true)
    await savePortable(app, win, 'refused.tsx', saved)
  } finally {
    await app.close()
  }
  try {
    await inBrowsers(
      saved,
      async (frame, _page, name) => {
        await frame.locator('#run').click()
        await expect
          .poll(async () => refused(await frame.locator('#result').textContent()), {
            message: name,
            timeout: 15_000,
          })
          .toBe(true)
      },
      { offline: false },
    )
    expect(outside.hits()).toBe(0)
  } finally {
    await outside.close()
  }
})

test('PRT-C31 a page that fetches a file beside it is refused in the preview, as in a browser', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const dir = home(dataHome)
  writeFileSync(join(dir, 'data.json'), '{"a":1}')
  writeFileSync(
    join(dir, 'fetches.html'),
    `<!doctype html><p id="out">waiting</p><script>
fetch('./data.json').then(() => { out.textContent = 'reached' }, () => { out.textContent = 'refused' })
</script>`,
  )
  const { app, win } = await launch(dataHome)
  try {
    await runInTerminal(win, 'cp ~/made/data.json "$OSTIA_ARTIFACTS/"')
    await openArtifact(win, 'fetches.html')
    await expect
      .poll(() => inGuest<string>(app, "document.getElementById('out')?.textContent ?? ''"), {
        timeout: 30_000,
      })
      .toBe('refused')
    await expect(win.getByTestId('preview-errors')).toContainText('Refused to connect')
  } finally {
    await app.close()
  }
})

const REPORT_REF = /@(\S*capture-\d+\.md)/g

test('PRT-C54 a region of a running preview goes to the agent as a report with its picture', async () => {
  test.setTimeout(240_000)
  const dataHome = freshDataHome()
  writeFileSync(join(home(dataHome), 'chart.tsx'), CHART)
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, editor: { openFilesIn: 'split' } })
  const bin = fakeAgentBin(dataHome)
  const base = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...base,
    env: { ...base.env, PATH: `${bin}:${base.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await openArtifact(win, 'chart.tsx')
    await expect
      .poll(() => inGuest<string>(app, "document.getElementById('inc')?.textContent ?? ''"), {
        timeout: 30_000,
      })
      .toBe('count 0')
    await startFakeAgent(win)
    await win.getByRole('button', { name: 'Capture region' }).click()
    const overlay = win.getByRole('application', { name: 'Drag over the page; Escape cancels' })
    const box = await overlay.boundingBox()
    if (!box) throw new Error('no region overlay')
    await win.mouse.move(box.x + 10, box.y + 10)
    await win.mouse.down()
    await win.mouse.move(box.x + 160, box.y + 90, { steps: 5 })
    await win.mouse.up()
    const bar = win.getByRole('toolbar', { name: 'Selection actions' })
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole('button', { name: 'Send to agent' }).click()
    await win.getByRole('menuitem').first().click()
    const terminal = win.locator('.xterm-rows').first()
    await expect(terminal).toContainText(/@\S*capture-\d+\.md/, { timeout: 15_000 })
    const refs = [...((await terminal.textContent()) ?? '').matchAll(REPORT_REF)]
    expect(refs).toHaveLength(1)
    const report = readFileSync(refs[0][1], 'utf8')
    expect(report).toContain('# Captured region:')
    expect(report).toMatch(/- Region: x 10, y 10, 150 × 80/)
    const png = /- Screenshot: (\S+\.png)/.exec(report)?.[1] ?? ''
    expect(readFileSync(png).subarray(0, 4).toString('hex')).toBe('89504e47')
  } finally {
    await app.close()
  }
})
