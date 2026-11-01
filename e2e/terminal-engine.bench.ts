import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { OstiaBridge } from '../src/shared/types'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch, SOFTWARE_WEBGL, seedSettings } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { BENCH_ENGINES } from './ghostty'
import { openWorkspace, waitForPaletteSelection } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

const BUSY_AGENT = resolve(__dirname, '../test/fixtures/agents/busy-agent.mjs')
const WINDOW_MS = 6_000
const BULK_LINES = 200_000
const CONTINUOUS_MS = 30_000
const HISTORY_OFF = process.env.OSTIA_BENCH_HISTORY === 'off'

function benchSettings(engine: (typeof BENCH_ENGINES)[number]): object {
  return {
    ...engine.settings,
    ...(HISTORY_OFF ? { terminal: { scrollbackHistory: 'off' } } : {}),
    workspaces: { confirmQuit: false },
  }
}

const PAGE_PROBE = `(() => {
  const p = { frames: 0, maxLag: 0, longTasks: 0, longMs: 0 }
  window.__bench = p
  const frame = () => { p.frames++; requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    p.maxLag = Math.max(p.maxLag, now - last - 10)
    last = now
  }, 10)
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) { p.longTasks++; p.longMs += e.duration }
  }).observe({ type: 'longtask', buffered: false })
})()`

for (const engine of BENCH_ENGINES) {
  for (const fps of [30, 60]) {
    test(`bench ${engine.name} busy agent ${fps}fps`, async () => {
      test.setTimeout(90_000)
      const dataHome = freshDataHome()
      seedSettings(dataHome, { ...engine.settings, workspaces: { confirmQuit: false } })
      const bin = fakeAgentBin(
        dataHome,
        `#!/bin/sh\nBUSY_AGENT_FPS=${fps} ELECTRON_RUN_AS_NODE=1 exec "$OSTIA_NODE" "${BUSY_AGENT}"\n`,
      )
      const launch = isolatedLaunch(dataHome)
      const app = await electron.launch({
        ...launch,
        args: [SOFTWARE_WEBGL, ...launch.args],
        env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
      })
      try {
        const win = await app.firstWindow()
        await win.waitForLoadState('domcontentloaded')
        await openTerminal(win)
        await win.keyboard.type('claude')
        await win.keyboard.press('Enter')
        await expect(win.locator('.pane-tab .title').first()).toHaveText(/Busy task$/, {
          timeout: 15_000,
        })
        await win.waitForTimeout(2_000)
        const result = await measure(app, win, WINDOW_MS)
        const surfaces = await win.evaluate(() => ({
          glCanvases: document.querySelectorAll('canvas[aria-hidden="true"]').length,
          canvases: document.querySelectorAll('canvas').length,
        }))
        console.log(`SURFACES ${engine.name} ${JSON.stringify(surfaces)}`)
        console.log(`BENCH ${engine.name} agent${fps} ${JSON.stringify(result)}`)
        await win.keyboard.press('Control+c')
      } finally {
        await app.close()
      }
    })
  }

  test(`bench ${engine.name} bulk output`, async () => {
    test.setTimeout(180_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, benchSettings(engine))
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openTerminal(win)
      await win.keyboard.type(
        `seq -f 'line %g of the bulk output test with some padding text' ${BULK_LINES}; printf '\\033]0;BULKDONE\\007'`,
      )
      const title = win.locator('.pane-tab .title').first()
      await win.evaluate(() => {
        const w = window as unknown as { __doneAt?: number }
        const el = document.querySelector('.pane-tab .title')
        if (!el) return
        new MutationObserver(() => {
          if (el.textContent === 'BULKDONE' && !w.__doneAt) w.__doneAt = performance.now()
        }).observe(el, { childList: true, characterData: true, subtree: true })
      })
      await app.evaluate(MAIN_PROBE)
      await win.evaluate(PAGE_PROBE)
      const startAt = await win.evaluate(() => performance.now())
      await win.keyboard.press('Enter')
      await expect(title).toHaveText('BULKDONE', { timeout: 100_000 })
      const doneAt = await win.evaluate(() => (window as unknown as { __doneAt: number }).__doneAt)
      const main = await app.evaluate(
        () => (globalThis as unknown as { __mainBench: Metrics }).__mainBench,
      )
      const page = await win.evaluate(() => (window as unknown as { __bench: Metrics }).__bench)
      const ms = Math.round(doneAt - startAt)
      console.log(
        `BENCH ${engine.name} bulk ${JSON.stringify({ ms, mainMaxLagMs: Math.round(main.maxLag), mainLagOver16: main.over16, pageMaxLagMs: Math.round(page.maxLag), fps: Math.round((page.frames * 1000) / ms), longTaskMs: Math.round(page.longMs) })}`,
      )
      if (!HISTORY_OFF) {
        console.log(
          `BENCH ${engine.name} history ${JSON.stringify(await measureHistory(win, dataHome))}`,
        )
      }
    } finally {
      await app.close()
    }
  })

  test(`bench ${engine.name} continuous output`, async () => {
    test.setTimeout(120_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, benchSettings(engine))
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openTerminal(win)
      await app.evaluate(() => {
        const rss = { peak: 0, heap: 0, external: 0, buffers: 0 }
        ;(globalThis as unknown as { __rss: typeof rss }).__rss = rss
        setInterval(() => {
          const now = process.memoryUsage()
          if (now.rss <= rss.peak) return
          rss.peak = now.rss
          rss.heap = now.heapUsed
          rss.external = now.external
          rss.buffers = now.arrayBuffers
        }, 100)
      })
      const mib = (bytes: number) => Math.round(bytes / 1024 / 1024)
      const rssNow = async () => mib(await app.evaluate(() => process.memoryUsage.rss()))
      const before = await rssNow()
      await win.keyboard.type('yes')
      await win.keyboard.press('Enter')
      await win.waitForTimeout(CONTINUOUS_MS)
      const peak = await app.evaluate(
        () =>
          (
            globalThis as unknown as {
              __rss: { peak: number; heap: number; external: number; buffers: number }
            }
          ).__rss,
      )
      await win.keyboard.press('Control+c')
      await win.waitForTimeout(10_000)
      console.log(
        `BENCH ${engine.name} continuous ${JSON.stringify({ beforeMiB: before, peakMiB: mib(peak.peak), heapMiB: mib(peak.heap), externalMiB: mib(peak.external), buffersMiB: mib(peak.buffers), afterMiB: await rssNow() })}`,
      )
    } finally {
      await app.close()
    }
  })
}

for (const engine of BENCH_ENGINES) {
  test(`bench ${engine.name} keystroke latency`, async () => {
    test.setTimeout(90_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, { ...engine.settings, workspaces: { confirmQuit: false } })
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openTerminal(win)
      await win.keyboard.type('cat')
      await win.keyboard.press('Enter')
      await win.waitForTimeout(1_000)
      await app.evaluate(({ ipcMain, BrowserWindow }) => {
        const now = () => performance.timeOrigin + performance.now()
        const stamps = { writes: [] as number[], data: [] as number[] }
        ;(globalThis as unknown as { __latency: typeof stamps }).__latency = stamps
        ipcMain.on('pty:write', () => stamps.writes.push(now()))
        const contents = BrowserWindow.getAllWindows()[0].webContents
        const send = contents.send.bind(contents)
        contents.send = (channel: string, ...args: unknown[]) => {
          if (channel.startsWith('pty:data:')) stamps.data.push(now())
          send(channel, ...args)
        }
      })
      await win.evaluate(() => {
        const now = () => performance.timeOrigin + performance.now()
        const stamps = { keys: [] as number[], frames: [] as number[] }
        ;(window as unknown as { __latency: typeof stamps }).__latency = stamps
        window.addEventListener('keydown', () => stamps.keys.push(now()), true)
        const frame = () => {
          stamps.frames.push(now())
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
      for (const key of 'the quick brown fox jumps over the lazy dog'.replaceAll(' ', '')) {
        await win.keyboard.press(key)
        await win.waitForTimeout(120)
      }
      const main = await app.evaluate(
        () =>
          (globalThis as unknown as { __latency: { writes: number[]; data: number[] } }).__latency,
      )
      const page = await win.evaluate(
        () => (window as unknown as { __latency: { keys: number[]; frames: number[] } }).__latency,
      )
      const after = (list: number[], t: number) => list.find((v) => v >= t)
      const hops = {
        toMain: [] as number[],
        echo: [] as number[],
        toFrame: [] as number[],
        total: [] as number[],
      }
      for (const key of page.keys) {
        const write = after(main.writes, key)
        const data = write === undefined ? undefined : after(main.data, write)
        const frame = data === undefined ? undefined : after(page.frames, data)
        if (write === undefined || data === undefined || frame === undefined) continue
        hops.toMain.push(write - key)
        hops.echo.push(data - write)
        hops.toFrame.push(frame - data)
        hops.total.push(frame - key)
      }
      const median = (v: number[]) => {
        const sorted = [...v].sort((a, b) => a - b)
        return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10
      }
      const p90 = (v: number[]) => {
        const sorted = [...v].sort((a, b) => a - b)
        return Math.round(sorted[Math.floor(sorted.length * 0.9)] * 10) / 10
      }
      const result = {
        keys: hops.total.length,
        keyToMainMs: median(hops.toMain),
        echoMs: median(hops.echo),
        echoToFrameMs: median(hops.toFrame),
        totalMs: median(hops.total),
        totalP90Ms: p90(hops.total),
      }
      console.log(`BENCH ${engine.name} latency ${JSON.stringify(result)}`)
      expect(result.keys).toBeGreaterThan(20)
    } finally {
      await app.close()
    }
  })
}

const AGENT_PANES = 6

for (const engine of BENCH_ENGINES) {
  test(`bench ${engine.name} ${AGENT_PANES} busy agents`, async () => {
    test.setTimeout(150_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, { ...engine.settings, workspaces: { confirmQuit: false } })
    const bin = fakeAgentBin(
      dataHome,
      `#!/bin/sh\nBUSY_AGENT_FPS=30 ELECTRON_RUN_AS_NODE=1 exec "$OSTIA_NODE" "${BUSY_AGENT}"\n`,
    )
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({
      ...launch,
      args: [SOFTWARE_WEBGL, ...launch.args],
      env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
    })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openTerminal(win)
      const busy = win.locator('.pane-tab .title', { hasText: /Busy task$/ })
      for (let pane = 1; pane <= AGENT_PANES; pane++) {
        await win.keyboard.type('claude')
        await win.keyboard.press('Enter')
        await expect(busy).toHaveCount(pane, { timeout: 15_000 })
        if (pane === AGENT_PANES) break
        await win.keyboard.press(pane % 2 ? 'Control+Alt+Backslash' : 'Control+Alt+Minus')
        await expect(win.locator('.ghostty-host:visible')).toHaveCount(pane + 1, {
          timeout: 15_000,
        })
        await win.waitForTimeout(1_000)
      }
      await win.waitForTimeout(2_000)
      const result = await measure(app, win, WINDOW_MS)
      const surfaces = await win.evaluate(() => ({
        glCanvases: document.querySelectorAll('canvas[aria-hidden="true"]').length,
        canvases: document.querySelectorAll('canvas').length,
      }))
      const gpu = await app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus())
      console.log(`SURFACES ${engine.name} ${JSON.stringify(surfaces)} ${JSON.stringify(gpu)}`)
      console.log(`BENCH ${engine.name} agents${AGENT_PANES} ${JSON.stringify(result)}`)
    } finally {
      await app.close()
    }
  })
}

type Metrics = Record<string, number>

function folderBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size
  }
  return total
}

async function measureHistory(win: Page, dataHome: string): Promise<Metrics> {
  const paneId =
    (await win.locator('.pane[data-pane-id]').first().getAttribute('data-pane-id')) ?? ''
  const stats = await win.evaluate(async (pane) => {
    const { pty } = (window as unknown as { ostia: OstiaBridge }).ostia
    const info = await pty.historyRead(pane, 0, 0)
    const started = performance.now()
    const all = await pty.historySearch(pane, 'bulk output', {}, 0)
    const searchMs = performance.now() - started
    const gaps = await pty.historySearch(pane, 'earlier lines not kept', {}, 0)
    const readAt = performance.now()
    await pty.historyRead(pane, 0, 6000)
    const readOldestMs = performance.now() - readAt
    const latestAt = performance.now()
    await pty.historyRead(pane, Math.max(0, (info?.end ?? 0) - 6000), 6000)
    const readLatestMs = performance.now() - latestAt
    return {
      first: info?.first ?? -1,
      readOldestMs: Math.round(readOldestMs),
      readLatestMs: Math.round(readLatestMs),
      lines: info ? info.end - info.first : -1,
      searchMs: Math.round(searchMs),
      matches: all?.count ?? -1,
      gaps: gaps?.count ?? -1,
    }
  }, paneId)
  const diskBytes = folderBytes(join(dataHome, 'ostia', 'scrollback'))
  const { first, ...historyStats } = stats
  const shownTop = win.locator(`.history-layer[data-top="${first}"]`)
  await win.keyboard.press(chords.palette)
  await win.locator('[data-slot="command-input"]').fill('Scroll to Top')
  await waitForPaletteSelection(win, 'Scroll to Top')
  await win.evaluate(watchHistoryShown, first)
  await win.evaluate(() => {
    const w = window as unknown as HistoryTimes
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter' && w.__historyFrom === undefined) w.__historyFrom = performance.now()
      },
      { capture: true },
    )
  })
  const openAt = Date.now()
  await win.keyboard.press('Enter')
  await expect(shownTop).toBeVisible({ timeout: 30_000 })
  const openMs = Date.now() - openAt
  const openInPageMs = await win.evaluate(historyTextShownAfter)
  const pageMs = openMs
  const pageInPageMs = openInPageMs
  await win.keyboard.press(chords.palette)
  await win.locator('[data-slot="command-input"]').fill('Scroll to Bottom')
  await waitForPaletteSelection(win, 'Scroll to Bottom')
  await win.keyboard.press('Enter')
  return {
    ...historyStats,
    diskBytes,
    bytesPerLine: +(diskBytes / Math.max(1, stats.lines)).toFixed(1),
    openMs,
    openInPageMs,
    pageMs,
    pageInPageMs,
  }
}

interface HistoryTimes {
  __historyFrom?: number
  __historyShown?: Promise<number>
}

function watchHistoryShown(first: number): void {
  const w = window as unknown as HistoryTimes
  w.__historyFrom = undefined
  w.__historyShown = new Promise((resolve) => {
    const shows = () => {
      const box = document.querySelector<HTMLElement>('.history-layer')
      return box?.style.visibility === 'visible' && box.dataset.top === String(first)
    }
    const observer = new MutationObserver(() => {
      if (!shows()) return
      observer.disconnect()
      requestAnimationFrame(() => resolve(performance.now()))
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-top'],
    })
  })
}

async function historyTextShownAfter(): Promise<number> {
  const w = window as unknown as HistoryTimes
  const shown = await w.__historyShown
  return Math.round((shown ?? Number.NaN) - (w.__historyFrom ?? Number.NaN))
}

function MAIN_PROBE(): void {
  const p = { maxLag: 0, over16: 0 }
  ;(globalThis as unknown as { __mainBench: typeof p }).__mainBench = p
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    const lag = now - last - 10
    p.maxLag = Math.max(p.maxLag, lag)
    if (lag > 16) p.over16++
    last = now
  }, 10)
}

async function measure(
  app: ElectronApplication,
  win: Page,
  windowMs: number,
): Promise<Record<string, number>> {
  const cdp = await win.context().newCDPSession(win)
  await cdp.send('Performance.enable')
  const read = async (): Promise<Metrics> => {
    const { metrics } = (await cdp.send('Performance.getMetrics')) as {
      metrics: { name: string; value: number }[]
    }
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
  }
  await win.evaluate(PAGE_PROBE)
  await app.evaluate(MAIN_PROBE)
  await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics())
  const before = await read()
  await win.waitForTimeout(windowMs)
  const after = await read()
  const cpu = await app.evaluate(({ app: electronApp }) => {
    const byType: Record<string, number> = {}
    for (const m of electronApp.getAppMetrics()) {
      byType[m.type] = (byType[m.type] ?? 0) + m.cpu.percentCPUUsage
    }
    return byType
  })
  const main = await app.evaluate(
    () => (globalThis as unknown as { __mainBench: Metrics }).__mainBench,
  )
  const probe = (await win.evaluate(
    () => (window as unknown as { __bench: Metrics }).__bench,
  )) as Metrics
  const seconds = windowMs / 1000
  const perSecond = (key: string) => Math.round(((after[key] - before[key]) * 1000) / seconds)
  return {
    taskMsPerS: perSecond('TaskDuration'),
    scriptMsPerS: perSecond('ScriptDuration'),
    layoutMsPerS: perSecond('LayoutDuration'),
    styleMsPerS: perSecond('RecalcStyleDuration'),
    fps: Math.round(probe.frames / seconds),
    maxTimerLagMs: Math.round(probe.maxLag),
    longTasks: probe.longTasks,
    longTaskMs: Math.round(probe.longMs),
    cpuTab: Math.round(cpu.Tab ?? 0),
    cpuGpu: Math.round(cpu.GPU ?? 0),
    cpuBrowser: Math.round(cpu.Browser ?? 0),
    mainMaxLagMs: Math.round(main.maxLag),
    mainLagOver16: main.over16,
  }
}

async function openTerminal(win: Page): Promise<void> {
  await openWorkspace(win)
  await win.locator('.ghostty-host, .ghostty-screen').first().click()
}
