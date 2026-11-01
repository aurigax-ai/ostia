import { resolve } from 'node:path'
import { freshDataHome, isolatedLaunch, SOFTWARE_WEBGL, seedSettings } from '../dataHome'
import { hookTerminal, installMainProbe, type MainProbe, type TerminalHandle } from '../echoProbe'
import { fakeAgentBin } from '../fakeAgent'
import { openWorkspace, quitApp } from '../helpers'
import { _electron as electron, expect, test } from '../test'
import { Samples, WARMUP } from './flowResults'

const INK_AGENT = resolve(__dirname, '../../test/fixtures/agents/ink-agent.mjs')
const LINES = 50000
const BURSTS = 12
const WHEELS_PER_BURST = 12
const WHEEL_GAP_MS = 8
const SETTINGS = {
  behavior: { gpuAcceleration: false, cursorBlink: false },
  terminal: { renderer: 'ghostty' },
  workspaces: { confirmQuit: false },
}

interface ScrollProbe {
  wheels: number[]
  moves: number[]
}

function scrollProbe(): void {
  const probe: ScrollProbe = { wheels: [], moves: [] }
  ;(window as unknown as { __scroll: ScrollProbe }).__scroll = probe
  window.addEventListener('wheel', (e) => probe.wheels.push(e.timeStamp), {
    capture: true,
    passive: true,
  })
  const term = (window as unknown as { __term: TerminalHandle }).__term
  term.onScroll(() => probe.moves.push(performance.now()))
}

test('bench agent scroll: wheel to scrolled rows in a long Claude-like transcript', async () => {
  test.setTimeout(240_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, SETTINGS)
  const bin = fakeAgentBin(
    dataHome,
    `#!/bin/sh\nINK_AGENT_LINES=${LINES} INK_AGENT_REGION_ROWS=24 INK_AGENT_FULL_REDRAW=0 INK_AGENT_SYNC=0 INK_AGENT_STREAM_FPS=0 ELECTRON_RUN_AS_NODE=1 exec "$OSTIA_NODE" "${INK_AGENT}"\n`,
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    args: [SOFTWARE_WEBGL, ...launch.args],
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  const samples = new Samples()
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await app.evaluate(installMainProbe)
    await openWorkspace(win)
    await win.locator('.ghostty-host').first().click()
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
    await win.evaluate(hookTerminal, { paneId, frameAfterWrite: true })
    await win.evaluate(scrollProbe)
    const box = await win.locator('.ghostty-screen').first().boundingBox()
    if (!box) throw new Error('no terminal box')
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let burst = 0; burst < BURSTS + WARMUP; burst++) {
      await win.evaluate(() => {
        const p = (window as unknown as { __scroll: ScrollProbe }).__scroll
        p.wheels = []
        p.moves = []
      })
      for (let i = 0; i < WHEELS_PER_BURST; i++) {
        await win.mouse.wheel(0, -100)
        await win.waitForTimeout(WHEEL_GAP_MS)
      }
      await win.waitForTimeout(400)
      const data = await win.evaluate(
        () => (window as unknown as { __scroll: ScrollProbe }).__scroll,
      )
      if (burst >= WARMUP) {
        for (const wheel of data.wheels) {
          const move = data.moves.find((m) => m >= wheel)
          if (move !== undefined) samples.add('agent-scroll.wheel-to-scroll', move - wheel)
        }
      }
      await win.keyboard.press('Control+End')
      await win.waitForTimeout(200)
    }
  } finally {
    await quitApp(app)
  }
  samples.flush()
})
