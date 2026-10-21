import { chords } from './chords'
import { freshDataHome, isolatedLaunch, SOFTWARE_WEBGL, seedSettings } from './dataHome'
import { BENCH_ENGINES } from './ghostty'
import { openWorkspace } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

const TABS = 10
const SWITCHES = 20
const SWITCH_GAP_MS = 400
const MIXED_XTERM_PANES = 3
const MIXED_GHOSTTY_TABS = 14
const TOO_MANY_CONTEXTS = /Too many active WebGL contexts/
const CONTEXT_PROBE = `(() => {
  const p = { created: 0, lost: 0, restored: 0 }
  window.__contexts = p
  const getContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    const known = this.__ostiaGl
    const context = getContext.call(this, kind, ...rest)
    if (context && !known && (kind === 'webgl2' || kind === 'webgl')) {
      this.__ostiaGl = true
      p.created++
      this.addEventListener('webglcontextlost', () => { p.lost++ })
      this.addEventListener('webglcontextrestored', () => { p.restored++ })
    }
    return context
  }
})()`

const SWITCH_PROBE = `(() => {
  const p = { keys: [], frames: [], longMs: 0 }
  window.__switch = p
  window.addEventListener('keydown', (e) => { if (e.key === 'Tab') p.keys.push(performance.now()) }, true)
  const frame = (t) => { p.frames.push(t); requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) p.longMs += e.duration
  }).observe({ type: 'longtask', buffered: false })
})()`

interface SwitchProbe {
  keys: number[]
  frames: number[]
  longMs: number
}

interface Launched {
  app: ElectronApplication
  win: Page
  warnings: () => number
}

async function launch(settings: object): Promise<Launched> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...settings, workspaces: { confirmQuit: false } })
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...options, args: [SOFTWARE_WEBGL, ...options.args] })
  const win = await app.firstWindow()
  let warned = 0
  win.on('console', (message) => {
    if (TOO_MANY_CONTEXTS.test(message.text())) warned++
  })
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(CONTEXT_PROBE)
  return { app, win, warnings: () => warned }
}

async function addTerminalTab(win: Page, tabs: number): Promise<void> {
  await win.keyboard.press(chords.newTab)
  await expect(win.locator('.pane-tab')).toHaveCount(tabs, { timeout: 15_000 })
  await win.waitForTimeout(500)
}

async function fill(win: Page): Promise<void> {
  await win.keyboard.type('seq -f "line %g with some \\033[31mred\\033[0m text" 3000')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(300)
}

async function contextCounts(
  win: Page,
): Promise<{ live: number; created: number; lost: number; restored: number }> {
  return win.evaluate(() => {
    const p = (
      window as unknown as {
        __contexts: { created: number; lost: number; restored: number }
      }
    ).__contexts
    return { live: p.created - p.lost, created: p.created, lost: p.lost, restored: p.restored }
  })
}

async function gpuRenderer(win: Page): Promise<string> {
  const renderer = await win.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'none'
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return renderer
  })
  if (process.env.OSTIA_E2E_GL_ARG && /swiftshader|llvmpipe|softpipe/i.test(renderer)) {
    throw new Error(`OSTIA_E2E_GL_ARG is set but WebGL runs in software: ${renderer}`)
  }
  return renderer
}

async function memoryMb(app: ElectronApplication): Promise<Record<string, number>> {
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({ type: m.type, kb: m.memory.workingSetSize })),
  )
  const mb = (type: string): number =>
    Math.round(metrics.filter((m) => m.type === type).reduce((sum, m) => sum + m.kb, 0) / 1024)
  return { rendererMb: mb('Tab'), gpuMb: mb('GPU'), totalMb: mb('Tab') + mb('GPU') + mb('Browser') }
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10
}

async function switchTabs(win: Page, switches: number): Promise<Record<string, number>> {
  await win.evaluate(SWITCH_PROBE)
  for (let i = 0; i < switches; i++) {
    await win.keyboard.press(chords.nextTab)
    await win.waitForTimeout(SWITCH_GAP_MS)
  }
  const probe = await win.evaluate(() => (window as unknown as { __switch: SwitchProbe }).__switch)
  const latencies = probe.keys.flatMap((key) => {
    const frames = probe.frames.filter((t) => t >= key)
    return frames.length >= 2 ? [frames[1] - key] : []
  })
  return {
    switches: latencies.length,
    medianMs: quantile(latencies, 0.5),
    p90Ms: quantile(latencies, 0.9),
    maxMs: quantile(latencies, 1),
    longTaskMs: Math.round(probe.longMs),
  }
}

async function fontChangeBlockMs(win: Page): Promise<number> {
  await win.evaluate(() => {
    const p = { maxLag: 0 }
    ;(window as unknown as { __font: typeof p }).__font = p
    let last = performance.now()
    setInterval(() => {
      const now = performance.now()
      p.maxLag = Math.max(p.maxLag, now - last - 10)
      last = now
    }, 10)
  })
  const box = await win
    .locator('.pane-slot:not([data-hidden]) .terminal-surface')
    .first()
    .boundingBox()
  if (!box) throw new Error('no shown terminal')
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.keyboard.down('ControlOrMeta')
  await win.mouse.wheel(0, -100)
  await win.keyboard.up('ControlOrMeta')
  await win.waitForTimeout(3_000)
  return win.evaluate(() =>
    Math.round((window as unknown as { __font: { maxLag: number } }).__font.maxLag),
  )
}

for (const engine of BENCH_ENGINES) {
  test(`bench ${engine.name} tab switch`, async () => {
    test.setTimeout(150_000)
    const { app, win, warnings } = await launch(engine.settings)
    try {
      await openWorkspace(win)
      await win.locator('.xterm, .ghostty-screen').first().click()
      await fill(win)
      for (let tab = 2; tab <= TABS; tab++) {
        await addTerminalTab(win, tab)
        await fill(win)
      }
      await switchTabs(win, TABS)
      const result = await switchTabs(win, SWITCHES)
      const fontBlockMs = await fontChangeBlockMs(win)
      const contexts = await contextCounts(win)
      const memory = await memoryMb(app)
      const renderer = await gpuRenderer(win)
      console.log(
        `BENCH ${engine.name} tabs${TABS} ${JSON.stringify({ ...result, fontBlockMs, contexts, memory, renderer, evictionWarnings: warnings() })}`,
      )
    } finally {
      await app.close()
    }
  })
}

test('bench mixed engines share the WebGL budget', async () => {
  test.setTimeout(240_000)
  const { app, win, warnings } = await launch({
    behavior: { gpuAcceleration: true },
    terminal: { renderer: 'xterm' },
    capabilities: { grants: ['settings-write'] },
  })
  try {
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    for (let pane = 2; pane <= MIXED_XTERM_PANES + 1; pane++) {
      if (pane === MIXED_XTERM_PANES + 1) {
        await win.keyboard.type(`ostia settings set terminal.renderer '"ghostty"'`)
        await win.keyboard.press('Enter')
        await win.waitForTimeout(1_000)
      }
      await win.keyboard.press(chords.splitRight)
      await expect(win.locator('.xterm, .ghostty-host')).toHaveCount(pane, { timeout: 15_000 })
      await win.waitForTimeout(500)
    }
    await expect(win.locator('.ghostty-host')).toHaveCount(1)
    for (let tab = 2; tab <= MIXED_GHOSTTY_TABS; tab++) {
      await addTerminalTab(win, MIXED_XTERM_PANES + tab)
    }
    const before = warnings()
    const result = await switchTabs(win, MIXED_GHOSTTY_TABS * 2)
    const contexts = await contextCounts(win)
    const memory = await memoryMb(app)
    const renderer = await gpuRenderer(win)
    console.log(
      `BENCH mixed xterm${MIXED_XTERM_PANES}+ghostty${MIXED_GHOSTTY_TABS} ${JSON.stringify({ ...result, contexts, memory, renderer, evictionWarnings: warnings(), warningsWhileSwitching: warnings() - before })}`,
    )
  } finally {
    await app.close()
  }
})
