import { createSocket } from 'node:dgram'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, seedSettings } from './dataHome'
import { expectHeld, launchWindow, openWorkspace, runInTerminal } from './helpers'
import { type ElectronApplication, expect, type Page, test } from './test'

const PREVIEW_URL = 'ostia-preview://'
const COPIED = 'copied-by-the-preview-page-7f3a'
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface Listener {
  port: number
  udpPort: number
  hits: () => number
  close: () => Promise<void>
}

async function listen(): Promise<Listener> {
  let hits = 0
  const tcp: Server = createServer((socket) => {
    hits += 1
    socket.on('error', () => {})
    socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok')
  })
  await new Promise<void>((ok) => tcp.listen(0, '127.0.0.1', ok))
  const udp = createSocket('udp4')
  udp.on('message', () => {
    hits += 1
  })
  await new Promise<void>((ok) => udp.bind(0, '127.0.0.1', ok))
  return {
    port: (tcp.address() as AddressInfo).port,
    udpPort: udp.address().port,
    hits: () => hits,
    close: async () => {
      udp.close()
      await new Promise<void>((ok) => tcp.close(() => ok()))
    },
  }
}

function probePage(port: number, udpPort: number): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>probing</title>
<link rel="dns-prefetch" href="http://127.0.0.1:${port}/">
<link rel="preconnect" href="http://127.0.0.1:${port}/">
<link rel="stylesheet" href="http://127.0.0.1:${port}/style.css">
<body>
<img id="remote" src="http://127.0.0.1:${port}/img.png">
<img id="inline" src="${PIXEL}">
<iframe src="http://127.0.0.1:${port}/frame"></iframe>
<form id="form" method="post" action="http://127.0.0.1:${port}/form"><input name="a" value="1"></form>
<a href="http://127.0.0.1:${port}/clicked" style="position:fixed;left:0;top:0;width:240px;height:40px;display:block;background:#eee">a link</a>
<a href="http://127.0.0.1:${port}/ctrl-clicked" style="position:fixed;left:0;top:60px;width:240px;height:40px;display:block;background:#ddd">another link</a>
<script src="http://127.0.0.1:${port}/script.js"></script>
<script>
const base = 'http://127.0.0.1:${port}'
const r = { ran: true }
window.__r = r
const attempt = async (name, run) => {
  try {
    r[name] = await run()
  } catch (e) {
    r[name] = 'threw:' + e.name
  }
}
;(async () => {
  await attempt('fetch', async () => {
    await fetch(base + '/fetch', { mode: 'no-cors' })
    return 'reached'
  })
  await attempt('xhr', () => new Promise((ok) => {
    const x = new XMLHttpRequest()
    x.onload = () => ok('reached')
    x.onerror = () => ok('failed')
    x.open('GET', base + '/xhr')
    x.send()
  }))
  await attempt('image', () => new Promise((ok) => {
    const i = new Image()
    i.onload = () => ok('reached')
    i.onerror = () => ok('failed')
    i.src = base + '/image.png'
  }))
  await attempt('websocket', () => new Promise((ok) => {
    const w = new WebSocket('ws://127.0.0.1:${port}/ws')
    w.onopen = () => ok('reached')
    w.onerror = () => ok('failed')
  }))
  await attempt('eventSource', () => new Promise((ok) => {
    const s = new EventSource(base + '/sse')
    s.onopen = () => ok('reached')
    s.onerror = () => {
      s.close()
      ok('failed')
    }
  }))
  await attempt('beacon', () => String(navigator.sendBeacon(base + '/beacon', 'x')))
  await attempt('dynamicImport', async () => {
    await import(base + '/mod.js')
    return 'reached'
  })
  await attempt('webrtc', () => new Promise((ok) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] })
    const found = []
    pc.onicecandidate = (e) => {
      if (e.candidate) found.push(e.candidate.candidate)
    }
    pc.createDataChannel('x')
    pc.createOffer().then((offer) => pc.setLocalDescription(offer))
    setTimeout(() => ok(found.filter((c) => c.includes('srflx') || c.includes('127.0.0.1')).length), 2500)
  }))
  await attempt('worker', () => new Promise((ok) => {
    const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })))
    w.onmessage = () => ok('ran')
    w.onerror = () => ok('blocked')
    setTimeout(() => ok('silent'), 1500)
  }))
  await attempt('clipboardWrite', async () => {
    await navigator.clipboard.writeText('written-without-a-gesture')
    return 'wrote'
  })
  await attempt('serviceWorker', async () => {
    await navigator.serviceWorker.register('./sw.js')
    return 'registered'
  })
  await attempt('localStorage', () => {
    localStorage.setItem('a', '1')
    return 'stored'
  })
  await attempt('sessionStorage', () => {
    sessionStorage.setItem('a', '1')
    return 'stored'
  })
  await attempt('cookie', () => {
    document.cookie = 'a=1'
    return document.cookie === '' ? 'empty' : 'stored'
  })
  await attempt('indexedDB', () => new Promise((ok) => {
    const q = indexedDB.open('x')
    q.onsuccess = () => ok('opened')
    q.onerror = () => ok('failed')
  }))
  await attempt('cacheStorage', async () => {
    await caches.open('x')
    return 'opened'
  })
  await attempt('clipboardRead', async () => {
    await navigator.clipboard.readText()
    return 'read'
  })
  await attempt('popup', () => String(window.open(base + '/popup')))
  await attempt('sibling', async () => (await (await fetch('./data.json')).json()).ok)
  await attempt('parentFolder', async () => (await fetch('../secret.txt')).status)
  await attempt('eval', () => String(eval('1 + 1')))
  r.ostia = typeof window.ostia
  r.require = typeof window.require
  r.process = typeof window.process
  r.origin = window.origin
  r.inlineImage = document.getElementById('inline').naturalWidth
  r.remoteImage = document.getElementById('remote').naturalWidth
  r.remoteScript = typeof window.__remoteScript
  document.title = 'probed'
  setTimeout(() => document.getElementById('form').submit(), 1000)
  setTimeout(() => {
    const meta = document.createElement('meta')
    meta.httpEquiv = 'refresh'
    meta.content = '0;url=' + base + '/refresh'
    document.head.append(meta)
  }, 2000)
  setTimeout(() => {
    location.href = base + '/nav'
    setTimeout(() => {
      window.__navigated = 'tried'
    }, 500)
  }, 3000)
})()
</script>
`
}

async function launch(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  seedSettings(dataHome, { ...CANVAS_RENDERER_SETTINGS, editor: { openFilesIn: 'split' } })
  const launched = await launchWindow(dataHome)
  await openWorkspace(launched.win)
  return launched
}

function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .map((wc) => wc.getURL())
        .filter((url) => url.startsWith(prefix)),
    PREVIEW_URL,
  )
}

function guestPixel(app: ElectronApplication, x: number, y: number): Promise<number[] | null> {
  return app.evaluate(
    async ({ webContents }, [prefix, px, py]) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(prefix))
      if (!guest) return null
      const image = await guest.capturePage({ x: px, y: py, width: 1, height: 1 })
      const [blue, green, red] = image.toBitmap()
      return [red, green, blue]
    },
    [PREVIEW_URL, x, y] as const,
  )
}

async function clickInGuest(
  app: ElectronApplication,
  x: number,
  y: number,
  modifiers: Array<'control'> = [],
): Promise<void> {
  await app.evaluate(
    ({ webContents }, [prefix, px, py, keys]) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(prefix))
      if (!guest) throw new Error('no preview guest')
      const modifiers = [...keys]
      guest.sendInputEvent({ type: 'mouseMove', x: px, y: py, modifiers })
      guest.sendInputEvent({
        type: 'mouseDown',
        x: px,
        y: py,
        button: 'left',
        clickCount: 1,
        modifiers,
      })
      guest.sendInputEvent({
        type: 'mouseUp',
        x: px,
        y: py,
        button: 'left',
        clickCount: 1,
        modifiers,
      })
    },
    [PREVIEW_URL, x, y, modifiers] as const,
  )
}

function guestTick(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }, prefix) => {
    const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(prefix))
    return Number(/^tick (\d+)$/.exec(guest?.getTitle() ?? '')?.[1] ?? -1)
  }, PREVIEW_URL)
}

function guestDebuggerAttached(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .find((wc) => wc.getURL().startsWith(prefix))
        ?.debugger.isAttached() ?? false,
    PREVIEW_URL,
  )
}

function guestTitle(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .find((wc) => wc.getURL().startsWith(prefix))
        ?.getTitle() ?? null,
    PREVIEW_URL,
  )
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

test('PRT-C30 a page in the artifact folder runs with no network, no way into Ostia, no storage and no navigation', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'site'), { recursive: true })
  const outside = await listen()
  writeFileSync(join(home, 'site', 'probe.html'), probePage(outside.port, outside.udpPort))
  writeFileSync(join(home, 'site', 'data.json'), '{"ok":"sibling-read"}')
  writeFileSync(join(home, 'secret.txt'), 'outside the page folder')
  const { app, win } = await launch(dataHome)
  try {
    await runInTerminal(
      win,
      'mkdir "$OSTIA_ARTIFACTS/probe" && cp ~/site/* "$OSTIA_ARTIFACTS/probe/" && cp ~/secret.txt "$OSTIA_ARTIFACTS/" && ostia open "$OSTIA_ARTIFACTS/probe/probe.html"',
    )
    await expect(win.getByTestId('html-preview')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(() => inGuest<string>(app, 'document.title'), { timeout: 30_000 })
      .toBe('probed')
    const results = JSON.parse(
      (await inGuest<string>(app, 'JSON.stringify(window.__r)')) ?? '{}',
    ) as Record<string, unknown>

    expect(results).toMatchObject({
      ran: true,
      fetch: 'threw:TypeError',
      xhr: 'failed',
      image: 'failed',
      websocket: 'failed',
      eventSource: 'failed',
      dynamicImport: 'threw:TypeError',
      webrtc: 0,
      worker: 'blocked',
      clipboardWrite: 'threw:NotAllowedError',
      localStorage: 'threw:SecurityError',
      sessionStorage: 'threw:SecurityError',
      cookie: 'threw:SecurityError',
      clipboardRead: 'threw:NotAllowedError',
      popup: 'null',
      sibling: 'threw:TypeError',
      parentFolder: 'threw:TypeError',
      eval: 'threw:EvalError',
      ostia: 'undefined',
      require: 'undefined',
      process: 'undefined',
      origin: 'null',
      inlineImage: 1,
      remoteImage: 0,
      remoteScript: 'undefined',
    })
    expect(results.serviceWorker).toMatch(/^threw:/)
    expect(results.indexedDB).toMatch(/^(threw:|failed)/)
    expect(results.cacheStorage).toMatch(/^threw:/)

    const strip = win.getByTestId('preview-errors')
    await expect(strip).toBeVisible()
    await strip.locator('.preview-strip-toggle').click()
    await expect(win.getByTestId('preview-error-list')).toContainText(
      `This page tried to reach 127.0.0.1:${outside.port}; previews have no network`,
    )

    await expect
      .poll(() => inGuest<string>(app, 'window.__navigated'), { timeout: 20_000 })
      .toBe('tried')
    const link = win.getByTestId('preview-link')
    await expect(link).toHaveCount(0)
    await clickInGuest(app, 20, 20)
    await expect(link).toContainText(`http://127.0.0.1:${outside.port}/clicked`, {
      timeout: 20_000,
    })
    await expect(link.getByRole('button', { name: 'Open in Browser Pane' })).toBeVisible()
    await clickInGuest(app, 20, 80, ['control'])
    await expect(link).toContainText(`http://127.0.0.1:${outside.port}/ctrl-clicked`, {
      timeout: 20_000,
    })
    const urls = await guestUrls(app)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(/^ostia-preview:\/\/[0-9a-f]{24}\/$/)
    expect(await inGuest<string>(app, 'document.title')).toBe('probed')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(outside.hits()).toBe(0)
  } finally {
    await app.close()
    await outside.close()
  }
})

const NAMES_PAGE = [
  '<!doctype html><title>names</title>',
  '<meta http-equiv="x-dns-prefetch-control" content="on">',
  '<link rel="dns-prefetch" href="//prefetch-probe.ostia-test.invalid">',
  '<link rel="preconnect" href="https://preconnect-probe.ostia-test.invalid">',
  '<link rel="prerender" href="https://prerender-probe.ostia-test.invalid/">',
  '<a href="http://anchor-probe.ostia-test.invalid/">a link</a>',
  '<script>',
  'for (const rel of ["dns-prefetch", "preconnect"]) {',
  '  const link = document.createElement("link")',
  '  link.rel = rel',
  '  link.href = "https://" + rel + "-script-probe.ostia-test.invalid/"',
  '  document.head.append(link)',
  '}',
  'Promise.allSettled([',
  '  new Promise((settled) => {',
  '    const image = new Image()',
  '    image.onload = image.onerror = settled',
  '    image.src = "https://image-probe.ostia-test.invalid/a.png"',
  '  }),',
  '  fetch("https://fetch-probe.ostia-test.invalid/"),',
  ']).then(() => { document.title = "names-done" })',
  '</script>',
].join('\n')

test('a page outside the artifact folder previews only when asked, reloads on a change and shows its errors, and a page in the artifact folder cannot make the resolver look up a host name (PRT-C30)', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'site'), { recursive: true })
  const page = join(home, 'site', 'page.html')
  writeFileSync(
    page,
    `<!doctype html><title>first</title><button id="b">count</button><script>let n = 0; document.getElementById("b").onclick = () => { n += 1; document.title = "clicked " + n; navigator.clipboard.writeText("${COPIED}") }</script>`,
  )
  writeFileSync(join(home, 'names.html'), NAMES_PAGE)
  const log = join(dataHome, 'preview-netlog.json')
  const { app, win } = await launch(dataHome)
  try {
    await runInTerminal(win, 'ostia open ~/site/page.html')
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
    await expect(win.getByTestId('html-preview')).toHaveCount(0)
    expect(await guestUrls(app)).toEqual([])

    await win.getByRole('button', { name: 'Run page in preview' }).click()
    await expect
      .poll(() => inGuest<string>(app, 'document.title'), { timeout: 20_000 })
      .toBe('first')
    expect(await guestPixel(app, 300, 300)).toEqual([255, 255, 255])
    await clickInGuest(app, 30, 20)
    await expect.poll(() => inGuest<string>(app, 'document.title')).toBe('clicked 1')
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toBe(COPIED)
    await expect(win.getByTestId('preview-errors')).toHaveCount(0)

    writeFileSync(
      page,
      '<!doctype html><title>second</title><script>throw new Error("boom-from-page")</script><script>nowhere()</script>',
    )
    await expect
      .poll(() => inGuest<string>(app, 'document.title'), { timeout: 20_000 })
      .toBe('second')
    const strip = win.getByTestId('preview-errors')
    await expect(strip).toContainText('2 errors', { timeout: 15_000 })
    await strip.locator('.preview-strip-toggle').click()
    const list = win.getByTestId('preview-error-list')
    await expect(list).toContainText('boom-from-page (page.html:1)')
    await expect(list).toContainText('nowhere')

    writeFileSync(
      page,
      '<!doctype html><title>tick 0</title><script>let n = 0; setInterval(() => { n += 1; document.title = "tick " + n }, 100)</script>',
    )
    await expect.poll(() => guestTick(app), { timeout: 20_000 }).toBeGreaterThan(3)
    await inGuest(app, 'window.__kept = "state of this load"')
    await win.keyboard.press('Control+Shift+n')
    await expect.poll(() => guestDebuggerAttached(app), { timeout: 20_000 }).toBe(true)
    let seen = -1
    await expect
      .poll(
        async () => {
          const tick = await guestTick(app)
          const unchanged = tick === seen
          seen = tick
          return unchanged
        },
        { timeout: 20_000, intervals: [300] },
      )
      .toBe(true)
    const frozenAt = seen
    await expectHeld(() => guestTick(app), frozenAt, 500)
    await win.keyboard.press('Control+1')
    await expect.poll(() => guestTick(app), { timeout: 20_000 }).toBeGreaterThan(frozenAt + 3)
    expect(await inGuest<string>(app, 'window.__kept')).toBe('state of this load')

    await win.getByRole('button', { name: 'Edit page source' }).click()
    await expect(win.getByTestId('html-preview')).toHaveCount(0)
    await expect.poll(() => guestUrls(app), { timeout: 10_000 }).toEqual([])
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText('setInterval')

    await runInTerminal(
      win,
      'cp ~/names.html "$OSTIA_ARTIFACTS/" && ostia open "$OSTIA_ARTIFACTS/names.html"',
    )
    await expect.poll(() => guestTitle(app), { timeout: 30_000 }).toBe('names-done')
    await app.evaluate(
      async ({ webContents }, [prefix, path]) => {
        const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(prefix))
        if (!guest) throw new Error('no preview guest')
        await guest.session.netLog.startLogging(path, { captureMode: 'everything' })
        const settled = new Promise<void>((resolve) => {
          const onTitle = (_event: unknown, title: string): void => {
            if (title !== 'names-done') return
            guest.off('page-title-updated', onTitle)
            resolve()
          }
          guest.on('page-title-updated', onTitle)
        })
        guest.reload()
        await settled
        await guest.session.resolveHost('control-probe.ostia-test.invalid').catch(() => null)
        await guest.session.netLog.stopLogging()
      },
      [PREVIEW_URL, log] as const,
    )
    const recorded = readFileSync(log, 'utf8')
    expect(recorded).toContain('control-probe.ostia-test.invalid')
    const looked = [...recorded.matchAll(/([a-z-]+-probe)\.ostia-test\.invalid/g)].map((m) => m[1])
    expect([...new Set(looked)]).toEqual(['control-probe'])
  } finally {
    await app.close()
  }
})

function writeSeed(path: string, groups: number): void {
  const db = new DatabaseSync(path)
  db.exec('create table t(k integer, v text)')
  db.exec(
    `with recursive n(i) as (select 1 union all select i + 1 from n where i < ${groups * 1000}) insert into t select i % ${groups}, printf('%040d', i) from n`,
  )
  db.close()
}

const WIDGET = `import { useEffect, useState } from 'react'
import { Line, LineChart, XAxis } from 'recharts'
import { Rocket } from 'lucide-react'
import { HeartIcon } from '@phosphor-icons/react'
import * as d3 from 'd3'
import Papa from 'papaparse'
import initSqlJs from 'sql.js'
import Part from './Part'
import data from './data.json'
import seed from './data.sqlite'

const points = Papa.parse('x,y\\n1,2\\n2,5\\n3,3', { header: true, dynamicTyping: true }).data

export default function Widget() {
  const [count, setCount] = useState<number>(0)
  const [loaded, setLoaded] = useState('')
  const [rows, setRows] = useState('loading')
  useEffect(() => {
    setLoaded(data.ok)
  }, [])
  useEffect(() => {
    initSqlJs().then((SQL) => {
      const db = new SQL.Database(seed)
      const [count, groups] = db.exec('select count(*), (select count(*) from (select k from t group by k)) from t')[0].values[0]
      setRows(count + ' rows ' + groups + ' groups')
    })
  }, [])
  useEffect(() => {
    document.title = 'count ' + count + ' ' + loaded + ' max ' + d3.max(points, (p) => p.y)
  }, [count, loaded])
  const probe = async () => {
    const r: Record<string, unknown> = { ostia: typeof (window as any).ostia, origin: window.origin }
    try {
      await fetch('http://127.0.0.1:__PORT__/from-component', { mode: 'no-cors' })
      r.fetch = 'reached'
    } catch (e) {
      r.fetch = 'threw'
    }
    try {
      localStorage.setItem('a', '1')
      r.storage = 'stored'
    } catch (e) {
      r.storage = 'threw'
    }
    try {
      r.evaluated = String(eval('1 + 1'))
    } catch (e) {
      r.evaluated = 'threw'
    }
    ;(window as any).__r = r
  }
  return (
    <div id="box" className="p-4 text-3xl font-bold">
      <button id="inc" style={{ position: 'fixed', left: 0, top: 0, width: 120, height: 40 }} onClick={() => setCount(count + 1)}>
        add
      </button>
      <button id="probe" style={{ position: 'fixed', left: 130, top: 0, width: 120, height: 40 }} onClick={probe}>
        probe
      </button>
      <button id="spin" style={{ position: 'fixed', left: 260, top: 0, width: 120, height: 40 }} onClick={() => { while (true) {} }}>
        spin
      </button>
      <Rocket /> <HeartIcon /> <Part label="part" /> <i id="rows">{rows}</i>
      <LineChart width={300} height={120} data={points}>
        <XAxis dataKey="x" />
        <Line dataKey="y" isAnimationActive={false} />
      </LineChart>
    </div>
  )
}
`

test('PRT-C30 a .tsx component runs with the bundled libraries, no eval, no network, and a runaway is stopped while the terminal keeps working', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'widget'), { recursive: true })
  const outside = await listen()
  writeFileSync(
    join(home, 'widget', 'Widget.tsx'),
    WIDGET.replace('__PORT__', String(outside.port)),
  )
  writeFileSync(
    join(home, 'widget', 'Part.tsx'),
    'export default function Part({ label }: { label: string }) { return <span id="part">{label}</span> }\n',
  )
  writeFileSync(join(home, 'widget', 'data.json'), '{"ok":"sibling"}')
  writeSeed(join(home, 'widget', 'data.sqlite'), 3)
  writeSeed(join(home, 'next.sqlite'), 5)
  const { app, win } = await launch(dataHome)
  try {
    await runInTerminal(
      win,
      'mkdir "$OSTIA_ARTIFACTS/widget" && cp ~/widget/* "$OSTIA_ARTIFACTS/widget/" && ostia open "$OSTIA_ARTIFACTS/widget/Widget.tsx"',
    )
    await expect(win.getByTestId('html-preview')).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => guestTitle(app), { timeout: 30_000 }).toBe('count 0 sibling max 5')
    expect(
      await inGuest<Record<string, unknown>>(
        app,
        `({
          padding: getComputedStyle(document.getElementById('box')).paddingTop,
          weight: getComputedStyle(document.getElementById('box')).fontWeight,
          part: document.getElementById('part').textContent,
          lucide: document.querySelectorAll('svg.lucide').length,
          chart: document.querySelectorAll('.recharts-surface').length,
          line: document.querySelectorAll('.recharts-line path').length,
          svgs: document.querySelectorAll('svg').length,
          importMaps: document.querySelectorAll('script[type=importmap]').length,
          external: document.querySelectorAll('script[src]').length,
        })`,
      ),
    ).toEqual({
      padding: '16px',
      weight: '700',
      part: 'part',
      lucide: 1,
      chart: 1,
      line: 1,
      svgs: 3,
      importMaps: 0,
      external: 0,
    })
    await expect(win.getByTestId('preview-errors')).toHaveCount(0)
    await expect
      .poll(() => inGuest<string>(app, "document.getElementById('rows').textContent"), {
        timeout: 30_000,
      })
      .toBe('3000 rows 3 groups')
    await runInTerminal(win, 'cp ~/next.sqlite "$OSTIA_ARTIFACTS/widget/data.sqlite"')
    await expect
      .poll(() => inGuest<string>(app, "document.getElementById('rows').textContent"), {
        timeout: 30_000,
      })
      .toBe('5000 rows 5 groups')

    await clickInGuest(app, 20, 20)
    await clickInGuest(app, 20, 20)
    await expect.poll(() => guestTitle(app)).toBe('count 2 sibling max 5')

    await clickInGuest(app, 150, 20)
    await expect
      .poll(() => inGuest<string>(app, 'JSON.stringify(window.__r ?? null)'), { timeout: 15_000 })
      .toBe(
        JSON.stringify({
          ostia: 'undefined',
          origin: 'null',
          fetch: 'threw',
          storage: 'threw',
          evaluated: 'threw',
        }),
      )
    await expect(win.getByTestId('preview-errors')).toContainText('previews have no network')
    expect(outside.hits()).toBe(0)

    await clickInGuest(app, 280, 20)
    await expect(win.getByTestId('preview-not-responding')).toBeVisible({ timeout: 20_000 })
    await runInTerminal(win, 'echo alive-$((40 + 2))')
    await expect(win.locator('.terminal-text').first()).toContainText('alive-42', { timeout: 5_000 })
    expect(
      await win.evaluate(
        () =>
          new Promise<number>((ok) => requestAnimationFrame((at) => ok(performance.now() - at))),
      ),
    ).toBeLessThan(500)
    const stopped = win.getByTestId('preview-stopped')
    await expect(stopped).toContainText('did not respond for 15 seconds', { timeout: 30_000 })
    await expect.poll(() => guestUrls(app), { timeout: 10_000 }).toHaveLength(0)

    await stopped.getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => guestTitle(app), { timeout: 20_000 }).toBe('count 0 sibling max 5')
    await expect(win.getByTestId('preview-stopped')).toHaveCount(0)
    expect(outside.hits()).toBe(0)
  } finally {
    await app.close()
    await outside.close()
  }
})
