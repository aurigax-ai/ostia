import { resolve } from 'node:path'
import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const INK_AGENT = resolve(__dirname, '../test/fixtures/agents/ink-agent.mjs')

const PROBE = `(() => {
  const p = { frames: [], longMs: 0, wheels: [], moves: [] }
  window.__scroll = p
  const slider = () => document.querySelector('.xterm-scrollable-element > .xterm-scrollbar.xterm-vertical .xterm-slider')
  const position = () => { const s = slider(); return s ? s.getBoundingClientRect().top : 0 }
  let last = performance.now()
  let lastTop = position()
  const frame = (now) => {
    p.frames.push(now - last)
    last = now
    const top = position()
    if (top !== lastTop) { p.moves.push(now); lastTop = top }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  window.addEventListener('wheel', (e) => p.wheels.push(e.timeStamp), { capture: true, passive: true })
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) p.longMs += e.duration
  }).observe({ type: 'longtask', buffered: false })
})()`

const CONFIGS = [
  { name: 'webgl-history-on', settings: { behavior: { gpuAcceleration: true } } },
  {
    name: 'webgl-history-off',
    settings: { behavior: { gpuAcceleration: true }, terminal: { scrollbackHistory: 'off' } },
  },
  { name: 'dom-history-on', settings: { behavior: { gpuAcceleration: false } } },
]

const PATTERNS = [
  { name: 'touchpad', delta: 6, intervalMs: 8, events: 250 },
  { name: 'notch', delta: 100, intervalMs: 60, events: 40 },
]

const STREAMING = [false, true]

function pct(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10
}

for (const config of CONFIGS) {
  for (const streaming of STREAMING) {
    test(`bench scroll ${config.name} ${streaming ? 'streaming' : 'idle'}`, async () => {
      test.setTimeout(120_000)
      const dataHome = freshDataHome()
      const terminal = {
        scrollbackLines: 10000,
        renderer: 'xterm',
        ...(config.settings as { terminal?: object }).terminal,
      }
      seedSettings(dataHome, {
        ...config.settings,
        terminal,
        workspaces: { confirmQuit: false },
      })
      const bin = fakeAgentBin(
        dataHome,
        `#!/bin/sh\nINK_AGENT_STREAM_FPS=${streaming ? 20 : 0} ELECTRON_RUN_AS_NODE=1 exec "$OSTIA_NODE" "${INK_AGENT}"\n`,
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
        await openWorkspace(win)
        await win.locator('.xterm').first().click()
        await win.keyboard.type('claude')
        await win.keyboard.press('Enter')
        await expect(win.locator('.pane-tab .title').first()).toHaveText(/Ink task$/, {
          timeout: 30_000,
        })
        await win.waitForTimeout(2_000)
        const box = await win.locator('.xterm-screen').first().boundingBox()
        if (!box) throw new Error('no terminal box')
        await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await win.evaluate(PROBE)
        const cdp = await win.context().newCDPSession(win)
        await cdp.send('Profiler.enable')
        for (const pattern of PATTERNS) {
          await cdp.send('Profiler.start')
          const result = await scroll(win, pattern)
          const { profile } = (await cdp.send('Profiler.stop')) as { profile: CpuProfile }
          console.log(
            `PROFILE ${config.name} ${streaming ? 'streaming' : 'idle'} ${pattern.name} ${JSON.stringify(topSelf(profile))}`,
          )
          console.log(
            `BENCH scroll ${config.name} ${streaming ? 'streaming' : 'idle'} ${pattern.name} ${JSON.stringify(result)}`,
          )
        }
      } finally {
        await app.close()
      }
    })
  }
}

async function scroll(
  win: Page,
  pattern: { delta: number; intervalMs: number; events: number },
): Promise<Record<string, number>> {
  await win.evaluate(() => {
    const p = (
      window as unknown as { __scroll: { frames: number[]; wheels: number[]; moves: number[] } }
    ).__scroll
    p.frames = []
    p.wheels = []
    p.moves = []
  })
  for (let i = 0; i < pattern.events; i++) {
    await win.mouse.wheel(0, -pattern.delta)
    await win.waitForTimeout(pattern.intervalMs)
  }
  await win.waitForTimeout(500)
  const data = await win.evaluate(() => {
    const p = (
      window as unknown as { __scroll: { frames: number[]; wheels: number[]; moves: number[] } }
    ).__scroll
    return { frames: p.frames, wheels: p.wheels, moves: p.moves, longMs: 0 }
  })
  const frames = data.frames
  const lag: number[] = []
  for (const w of data.wheels) {
    const move = data.moves.find((m) => m >= w)
    if (move !== undefined) lag.push(move - w)
  }
  const scrolled = await win.evaluate(
    () =>
      document
        .querySelector('.xterm-scrollbar.xterm-vertical .xterm-slider')
        ?.getBoundingClientRect().top ?? -1,
  )
  await win.keyboard.press('Control+End')
  await win.mouse.wheel(0, 100000)
  await win.waitForTimeout(300)
  return {
    wheels: data.wheels.length,
    moves: data.moves.length,
    frames: frames.length,
    frameP50: pct(frames, 0.5),
    frameP95: pct(frames, 0.95),
    frameMax: pct(frames, 1),
    over33: frames.filter((f) => f > 33).length,
    inputToScrollP50: pct(lag, 0.5),
    inputToScrollP95: pct(lag, 0.95),
    scrollTop: Math.round(scrolled),
  }
}

interface CpuProfile {
  nodes: {
    id: number
    callFrame: { functionName: string; url: string; lineNumber: number }
  }[]
  samples: number[]
  timeDeltas: number[]
}

function topSelf(profile: CpuProfile): string[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map<string, number>()
  profile.samples.forEach((id, i) => {
    const frame = byId.get(id)?.callFrame
    if (!frame) return
    const file = frame.url.split('/').pop() ?? ''
    const key = `${frame.functionName || '(anon)'} ${file}:${frame.lineNumber}`
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000)
  })
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([key, ms]) => `${Math.round(ms)}ms ${key}`)
}
