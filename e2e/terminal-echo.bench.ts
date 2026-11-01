import { resolve } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch, SOFTWARE_WEBGL, seedSettings } from './dataHome'
import {
  alignKeys,
  hookTerminal,
  installMainProbe,
  type MainProbe,
  percentile,
  readProbes,
  startMainProfile,
  stopMainProfile,
  summarize,
} from './echoProbe'
import { fakeAgentBin } from './fakeAgent'
import { BENCH_ENGINES } from './ghostty'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, type Page, test } from './test'

const BUSY_AGENT = resolve(__dirname, '../test/fixtures/agents/busy-agent.mjs')
const KEYS = Number(process.env.OSTIA_ECHO_KEYS ?? 80)
const ENGINES = (process.env.OSTIA_ECHO_ENGINES ?? '').split(',').filter(Boolean)
const TERMINALS = '.ghostty-host, .ghostty-host'

const SCENARIOS = [
  { name: 'idle', start: null },
  { name: 'agent', start: 'claude' },
  { name: 'flood', start: "yes 'streaming output line with some padding text to read'" },
]

for (const engine of BENCH_ENGINES.filter(
  (e) => ENGINES.length === 0 || ENGINES.includes(e.name),
)) {
  for (const scenario of SCENARIOS) {
    test(`bench echo ${engine.name} ${scenario.name}`, async () => {
      test.setTimeout(120_000)
      const dataHome = freshDataHome()
      seedSettings(dataHome, {
        ...engine.settings,
        behavior: { ...engine.settings.behavior, cursorBlink: false },
        workspaces: { confirmQuit: false },
      })
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
        await openWorkspace(win)
        await win.locator(TERMINALS).first().click()
        if (scenario.start) {
          await win.keyboard.type(scenario.start)
          await win.keyboard.press('Enter')
          await win.waitForTimeout(2_000)
        }
        await app.evaluate(installMainProbe)
        if (scenario.name !== 'idle') {
          await app.evaluate(startMainProfile)
          await profileStart(win)
        }
        await win.keyboard.press(chords.splitRight)
        await expect(win.locator(TERMINALS)).toHaveCount(2, { timeout: 15_000 })
        await win.waitForTimeout(1_500)
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
        const summary = summarize(timelines)
        console.log(
          `BENCH echo ${engine.name} ${scenario.name} ${JSON.stringify({ keys: page.keys.length, matched: timelines.length, seen: { inputs: page.inputs.length, arrivals: page.arrivals.length, writeDone: page.writeDone.length, renders: page.renders.length, frameEnds: page.frameEnds.length, recv: main.recv.length, send: main.send.length }, mainLagP95: percentile(main.lag, 0.95), mainLagMax: percentile(main.lag, 1), ...summary })}`,
        )
        if (scenario.name !== 'idle') {
          console.log(
            `PROFILE main ${engine.name} ${scenario.name} ${JSON.stringify(await app.evaluate(stopMainProfile))}`,
          )
          console.log(
            `PROFILE renderer ${engine.name} ${scenario.name} ${JSON.stringify(await profileStop(win))}`,
          )
        }
        expect(timelines.length).toBeGreaterThan(KEYS / 2)
      } finally {
        await app.close()
      }
    })
  }
}

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]
  samples: number[]
  timeDeltas: number[]
}

const sessions = new WeakMap<Page, { send: (m: string) => Promise<unknown> }>()

async function profileStart(win: Page): Promise<void> {
  const cdp = await win.context().newCDPSession(win)
  sessions.set(win, cdp as never)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.start')
}

async function profileStop(win: Page): Promise<string[]> {
  const cdp = sessions.get(win)
  if (!cdp) return []
  const { profile } = (await cdp.send('Profiler.stop')) as { profile: CpuProfile }
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
    .slice(0, 12)
    .map(([key, ms]) => `${Math.round(ms)}ms ${key}`)
}
