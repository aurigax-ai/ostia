import { resolve } from 'node:path'
import { _electron as electron, expect, test } from './test'
import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { emptyState, emptyWorkspace } from './helpers'

const BUSY_AGENT = resolve(__dirname, '../test/fixtures/agents/busy-agent.mjs')
const WINDOW_MS = 6_000
const BULK_LINES = 200_000

const ENGINES = [
  { name: 'xterm-dom', settings: { behavior: { gpuAcceleration: false } } },
  { name: 'xterm-webgl', settings: { behavior: { gpuAcceleration: true } } },
  {
    name: 'ghostty-canvas',
    settings: { behavior: { gpuAcceleration: false }, terminal: { renderer: 'ghostty' } },
  },
  {
    name: 'ghostty-gpu',
    settings: { behavior: { gpuAcceleration: true }, terminal: { renderer: 'ghostty' } },
  },
]

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

for (const engine of ENGINES) {
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
    test.setTimeout(120_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, { ...engine.settings, workspaces: { confirmQuit: false } })
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
    } finally {
      await app.close()
    }
  })
}

for (const engine of ENGINES) {
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

for (const engine of ENGINES) {
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
        await expect(win.locator('.pane-tab .title', { hasText: /^zsh$/ })).toHaveCount(1, {
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
  app: import('@playwright/test').ElectronApplication,
  win: import('@playwright/test').Page,
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
  const profiling = process.env.BENCH_PROFILE === '1'
  if (profiling) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await cdp.send('Profiler.start')
  }
  await win.waitForTimeout(windowMs)
  const after = await read()
  if (profiling) {
    const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`/tmp/bench-${Date.now()}.cpuprofile`, JSON.stringify(profile))
  }
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

async function openTerminal(win: import('@playwright/test').Page): Promise<void> {
  await emptyState(win)
    .getByRole('button', { name: /New workspace/ })
    .click()
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
  await expect(win.locator('.pane-tab .title').first()).toHaveText('zsh', { timeout: 15_000 })
  await win.locator('.xterm, .ghostty-screen').first().click()
  await win.waitForTimeout(2_500)
}
