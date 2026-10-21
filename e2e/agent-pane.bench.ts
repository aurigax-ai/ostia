import { resolve } from 'node:path'
import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import {
  type MainProbe,
  type TerminalHandle,
  alignKeys,
  hookTerminal,
  installMainProbe,
  percentile,
  readProbes,
  summarize,
} from './echoProbe'
import { fakeAgentBin } from './fakeAgent'
import { BENCH_ENGINES } from './ghostty'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const INK_AGENT = resolve(__dirname, '../test/fixtures/agents/ink-agent.mjs')
const KEYS = Number(process.env.OSTIA_AGENT_KEYS ?? 60)
const LINES = Number(process.env.OSTIA_AGENT_LINES ?? 50000)
const SYNC = process.env.OSTIA_AGENT_SYNC === '1' ? '1' : '0'
const ENGINES = (process.env.OSTIA_AGENT_ENGINES ?? '').split(',').filter(Boolean)
const TERMINALS = '.xterm, .ghostty-host'

const PATTERNS = [
  { name: 'touchpad', delta: 6, intervalMs: 8, events: 250 },
  { name: 'notch', delta: 100, intervalMs: 60, events: 40 },
  { name: 'fling', delta: 400, intervalMs: 16, events: 120 },
]

const MODES = [
  { name: 'idle', fps: 0 },
  { name: 'streaming', fps: 30 },
]

interface ScrollProbe {
  frames: number[]
  wheels: number[]
  moves: number[]
}

for (const engine of BENCH_ENGINES.filter(
  (e) => ENGINES.length === 0 || ENGINES.includes(e.name),
)) {
  for (const mode of MODES) {
    test(`bench agent ${engine.name} ${mode.name} sync${SYNC}`, async () => {
      test.setTimeout(240_000)
      const dataHome = freshDataHome()
      seedSettings(dataHome, {
        ...engine.settings,
        behavior: { ...engine.settings.behavior, cursorBlink: false },
        workspaces: { confirmQuit: false },
      })
      const bin = fakeAgentBin(
        dataHome,
        `#!/bin/sh\nINK_AGENT_LINES=${LINES} INK_AGENT_REGION_ROWS=24 INK_AGENT_SYNC=${SYNC} INK_AGENT_STREAM_FPS=${mode.fps} ELECTRON_RUN_AS_NODE=1 exec "$OSTIA_NODE" "${INK_AGENT}"\n`,
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
        await app.evaluate(installMainProbe)
        await openWorkspace(win)
        await win.locator(TERMINALS).first().click()
        await win.keyboard.type('claude')
        await win.keyboard.press('Enter')
        await expect(win.locator('.pane-tab .title').first()).toHaveText(/Ink task$/, {
          timeout: 60_000,
        })
        await win.waitForTimeout(3_000)
        await win.keyboard.press('x')
        await win.waitForTimeout(300)
        const warm = await app.evaluate(
          () => (globalThis as unknown as { __echoMain: MainProbe }).__echoMain,
        )
        const paneId = warm.writes[warm.writes.length - 1]?.paneId
        if (!paneId) throw new Error('warm-up key reached no pty')
        const pid = warm.spawns[warm.spawns.length - 1]
        await win.evaluate(hookTerminal, {
          paneId,
          frameAfterWrite: engine.name.startsWith('ghostty'),
        })
        await win.waitForTimeout(300)
        const letters = 'abcdefghijklmnopqrstuvwxyz'
        for (let i = 0; i < KEYS; i++) {
          await win.keyboard.press(letters[i % letters.length])
          await win.waitForTimeout(200 + Math.floor(Math.random() * 60))
        }
        await win.waitForTimeout(500)
        const { main, page } = await readProbes(app, win)
        const timelines = alignKeys(main, page, paneId, pid)
        console.log(
          `BENCH echo ${engine.name} ${mode.name} sync${SYNC} ${JSON.stringify({ keys: page.keys.length, matched: timelines.length, seen: { inputs: page.inputs.length, arrivals: page.arrivals.length, writeDone: page.writeDone.length, renders: page.renders.length, frameEnds: page.frameEnds.length, writes: main.writes.length, recv: main.recv.length, flush: main.flush.length, send: main.send.length }, mainLagP95: percentile(main.lag, 0.95), ...summarize(timelines) })}`,
        )

        await win.evaluate(hookScroll)
        const box = await win.locator('.xterm-screen, .ghostty-screen').first().boundingBox()
        if (!box) throw new Error('no terminal box')
        await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        const cdp = await win.context().newCDPSession(win)
        await cdp.send('Profiler.enable')
        for (const pattern of PATTERNS) {
          await cdp.send('Profiler.start')
          const result = await scroll(win, pattern)
          const { profile } = (await cdp.send('Profiler.stop')) as { profile: CpuProfile }
          console.log(
            `PROFILE scroll ${engine.name} ${mode.name} sync${SYNC} ${pattern.name} ${JSON.stringify(topSelf(profile))}`,
          )
          console.log(
            `BENCH scroll ${engine.name} ${mode.name} sync${SYNC} ${pattern.name} ${JSON.stringify(result)}`,
          )
        }
        expect(timelines.length).toBeGreaterThan(KEYS / 2)
      } finally {
        await app.close()
      }
    })
  }
}

function hookScroll(): void {
  const probe: ScrollProbe = { frames: [], wheels: [], moves: [] }
  ;(window as unknown as { __scroll: ScrollProbe }).__scroll = probe
  let last = performance.now()
  const frame = (now: number) => {
    probe.frames.push(now - last)
    last = now
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  window.addEventListener('wheel', (e) => probe.wheels.push(e.timeStamp), {
    capture: true,
    passive: true,
  })
  const term = (window as unknown as { __term: TerminalHandle }).__term
  term.onScroll(() => probe.moves.push(performance.now()))
}

async function scroll(
  win: Page,
  pattern: { delta: number; intervalMs: number; events: number },
): Promise<Record<string, number>> {
  await win.evaluate(() => {
    const p = (window as unknown as { __scroll: ScrollProbe }).__scroll
    p.frames = []
    p.wheels = []
    p.moves = []
  })
  for (let i = 0; i < pattern.events; i++) {
    if (i % 20 === 0) await win.mouse.wheel(0, -pattern.delta)
    await win.waitForTimeout(pattern.intervalMs)
  }
  await win.waitForTimeout(500)
  const data = await win.evaluate(() => {
    const p = (window as unknown as { __scroll: ScrollProbe }).__scroll
    return { frames: p.frames, wheels: p.wheels, moves: p.moves }
  })
  const lag: number[] = []
  for (const w of data.wheels) {
    const move = data.moves.find((m) => m >= w)
    if (move !== undefined) lag.push(move - w)
  }
  await win.keyboard.press('Control+End')
  await win.mouse.wheel(0, 100000)
  await win.waitForTimeout(300)
  return {
    wheels: data.wheels.length,
    moves: data.moves.length,
    frames: data.frames.length,
    frameP50: percentile(data.frames, 0.5),
    frameP95: percentile(data.frames, 0.95),
    frameMax: percentile(data.frames, 1),
    over33: data.frames.filter((f) => f > 33).length,
    inputToScrollP50: percentile(lag, 0.5),
    inputToScrollP95: percentile(lag, 0.95),
  }
}

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]
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
