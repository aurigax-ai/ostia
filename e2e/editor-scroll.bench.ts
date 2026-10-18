import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chords } from './chords'
import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { openWorkspace, typeLine } from './helpers'
import { type CDPSession, type Page, _electron as electron, expect, test } from './test'

const BUSY_AGENT = resolve(__dirname, '../test/fixtures/agents/busy-agent.mjs')
const DOC_LINES = 2_000
const WHEEL_STEPS = 120
const WHEEL_PX = 120
const WHEEL_GAP_MS = 16
const LONG_TASK_MS = 50
const FRAME_BUDGET_MS = 1000 / 60
const SCROLL_START = 'bench-scroll-start'
const SCROLL_END = 'bench-scroll-end'

const TRACE_CATEGORIES = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
].join(',')

const SCENARIOS = [
  { name: 'alone', agents: 0, settings: {} },
  { name: 'alone-wrap', agents: 0, settings: { editor: { wordWrap: 'on' } } },
  { name: 'busy4-webgl', agents: 4, settings: {} },
  { name: 'busy4-dom', agents: 4, settings: { behavior: { gpuAcceleration: false } } },
]

function markdownDoc(): string {
  const box = [
    '```',
    ' human ──▶ window ──▶ extension panel (ext-screens, no preload)',
    '                       │ http+ws 127.0.0.1:<rand>/<token>/   (loopback panel)',
    '                       ▼',
    '              screens extension process (Node, marketplace, ext.* only)',
    '                       │ Unix socket, client token',
    ' agent CLI ── MCP stdio ──▶ screens daemon ◀── `screens` CLI',
    ' (Claude Code, Codex)  │  owns: screens, tokens, input owner, action log, limits',
    '                       │  never connects into a screen; it only listens',
    '      ┌────────────────┼──────────────────────┬────────────────────┐',
    '      ▼                ▼                      ▼                    ▼',
    '  srt host (Node, one  OCI backend            Lume backend         assist backend',
    '  per screen; bwrap)   Podman/Docker/Apple    (macOS VM, HTTP API  (real desktop: X11',
    '  └ Xvfb + WM + apps   `container`, same img  on :7777, VNC)       Wayland portal)',
    '```',
  ]
  const lines: string[] = []
  for (let section = 1; lines.length < DOC_LINES; section++) {
    lines.push(`## ${section}. Architecture and trust boundaries`, '')
    lines.push(
      `Inputs: vault \`research/computer-use-${section}\`, \`architecture/sandboxed-workspaces\`, \`specs/keep-shells/sandboxed-shells\`, \`src/main/sandbox/\`,`,
      `the extension panel code (\`ExtensionHost.resolvePanel\`, \`isAllowedPanelUrl\`, \`hardenExtensionGuest\`), and the decisions of section ${section}.`,
      '',
    )
    for (let item = 1; item <= 6; item++) {
      lines.push(
        `- G${item}. An agent gets its own screen (sandbox mode) that never touches the human's screen, input, focus, clipboard, session bus or accessibility bus. **Default** mode.`,
        `  focus, clipboard, session bus or accessibility bus; see \`#${600 + item}\` and the fork.`,
      )
    }
    lines.push('', ...box, '')
    lines.push(
      `1. **screens daemon** (Node 22, TypeScript): one per user. Listens on a Unix socket; holds tokens, input owner and limits for section ${section}.`,
      '',
    )
  }
  return `# Computer use plan\n\n${lines.slice(0, DOC_LINES).join('\n')}\n`
}

for (const scenario of SCENARIOS) {
  test(`bench editor scroll ${scenario.name}`, async () => {
    test.setTimeout(180_000)
    const dataHome = freshDataHome()
    const docs = join(dataHome, 'docs')
    mkdirSync(docs, { recursive: true })
    const doc = join(docs, 'plan.md')
    writeFileSync(doc, markdownDoc())
    seedSettings(dataHome, { workspaces: { confirmQuit: false }, ...scenario.settings })
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
      const terminals = win.locator('.xterm:visible, .ghostty-screen:visible')
      await terminals.first().click()
      await win.keyboard.press(chords.splitRight)
      await expect(terminals).toHaveCount(2)
      await terminals.nth(1).click()
      await typeLine(win, `ostia open '${doc}'`)
      const lines = win.locator('.monaco-editor:visible .view-lines').first()
      await expect(lines).toContainText('Computer use plan', { timeout: 15_000 })
      await startAgents(win, scenario.agents)
      await win.waitForTimeout(2_000)
      const result = await scrollAndTrace(win, scenario.name)
      console.log(`BENCH editor-scroll ${scenario.name} ${JSON.stringify(result)}`)
    } finally {
      await app.close()
    }
  })
}

async function startAgents(win: Page, count: number): Promise<void> {
  if (count === 0) return
  await win.locator('.xterm, .ghostty-screen').first().click()
  const busy = win.locator('.pane-tab .title', { hasText: /Busy task$/ })
  for (let pane = 1; pane <= count; pane++) {
    await typeLine(win, 'claude')
    await expect(busy).toHaveCount(pane, { timeout: 15_000 })
    if (pane === count) break
    await win.keyboard.press('Control+Alt+Minus')
    await win.waitForTimeout(1_500)
  }
}

interface TraceEvent {
  name: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  args?: { name?: string; data?: Record<string, unknown> }
}

async function scrollAndTrace(win: Page, label: string): Promise<Record<string, number>> {
  const editor = win.locator('.monaco-editor:visible').first()
  const box = await editor.boundingBox()
  if (!box) throw new Error('editor is not laid out')
  const x = Math.round(box.x + box.width / 2)
  const y = Math.round(box.y + box.height / 2)
  const cdp = await win.context().newCDPSession(win)
  await cdp.send('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReturnAsStream' })
  await win.waitForTimeout(1_000)
  await win.evaluate((startMark) => {
    const w = window as unknown as { __probe: { frames: number[]; maxScroll: number; on: boolean } }
    const content = document.querySelector<HTMLElement>(
      '.monaco-editor:not([data-hidden]) .lines-content',
    )
    const probe = { frames: [] as number[], maxScroll: 0, on: true }
    w.__probe = probe
    const frame = (t: number) => {
      probe.frames.push(t)
      probe.maxScroll = Math.max(probe.maxScroll, -Number.parseFloat(content?.style.top ?? '0'))
      if (probe.on) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    performance.mark(startMark)
  }, SCROLL_START)
  const startedAt = Date.now()
  for (let step = 0; step < WHEEL_STEPS; step++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY: step < WHEEL_STEPS / 2 ? WHEEL_PX : -WHEEL_PX,
    })
    await win.waitForTimeout(WHEEL_GAP_MS)
  }
  await win.waitForTimeout(300)
  const scrollMs = Date.now() - startedAt
  const probe = await win.evaluate((endMark) => {
    performance.mark(endMark)
    const p = (
      window as unknown as { __probe: { frames: number[]; maxScroll: number; on: boolean } }
    ).__probe
    p.on = false
    return { frames: p.frames, maxScroll: p.maxScroll }
  }, SCROLL_END)
  const events = await stopTrace(cdp, label)
  expect(probe.maxScroll).toBeGreaterThan(WHEEL_PX * 10)
  return {
    scrollMs,
    maxScrollPx: Math.round(probe.maxScroll),
    ...frameStats(probe.frames),
    ...taskStats(events),
  }
}

async function stopTrace(cdp: CDPSession, label: string): Promise<TraceEvent[]> {
  const done = new Promise<string>((resolveStream) =>
    cdp.once('Tracing.tracingComplete', (e) => resolveStream(e.stream as string)),
  )
  await cdp.send('Tracing.end')
  const handle = await done
  let text = ''
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle })
    text += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data
    if (chunk.eof) break
  }
  await cdp.send('IO.close', { handle })
  const out = test.info().outputPath(`editor-scroll-${label}.trace.json`)
  writeFileSync(out, text)
  console.log(`TRACE ${label} ${out}`)
  const parsed = JSON.parse(text) as { traceEvents: TraceEvent[] } | TraceEvent[]
  return Array.isArray(parsed) ? parsed : parsed.traceEvents
}

function frameStats(frames: number[]): Record<string, number> {
  const gaps = frames.slice(1).map((t, i) => t - frames[i])
  const sorted = [...gaps].sort((a, b) => a - b)
  const at = (q: number) =>
    round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))])
  return {
    frames: gaps.length,
    frameP50Ms: at(0.5),
    frameP95Ms: at(0.95),
    frameMaxMs: round(sorted[sorted.length - 1] ?? 0),
    framesOver16: gaps.filter((g) => g > FRAME_BUDGET_MS * 1.2).length,
  }
}

function taskStats(events: TraceEvent[]): Record<string, number> {
  const mainThread = windowThread(events)
  const mark = (name: string) => events.find((e) => e.name === name)?.ts ?? Number.NaN
  const from = mark(SCROLL_START)
  const to = mark(SCROLL_END)
  const own = events.filter(
    (e) =>
      e.pid === mainThread.pid &&
      e.tid === mainThread.tid &&
      e.ph === 'X' &&
      e.ts >= from &&
      e.ts <= to,
  )
  const tasks = own.filter((e) => e.name === 'RunTask' && e.dur !== undefined)
  const long = tasks.filter((e) => (e.dur ?? 0) / 1000 > LONG_TASK_MS)
  const total = (name: string) => round(own.filter((e) => e.name === name).reduce(sumDur, 0) / 1000)
  return {
    taskMs: round(tasks.reduce(sumDur, 0) / 1000),
    longTasks: long.length,
    longTaskMaxMs: round(Math.max(0, ...long.map((e) => (e.dur ?? 0) / 1000))),
    scriptMs: total('FunctionCall'),
    styleMs: total('UpdateLayoutTree'),
    layoutMs: total('Layout'),
    paintMs: total('Paint'),
    prePaintMs: total('PrePaint'),
    layerizeMs: total('Layerize'),
  }
}

function windowThread(events: TraceEvent[]): TraceEvent {
  const frameCount = (thread: TraceEvent) =>
    events.filter(
      (e) => e.pid === thread.pid && e.tid === thread.tid && e.name === 'FireAnimationFrame',
    ).length
  const threads = events
    .filter((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
    .sort((a, b) => frameCount(b) - frameCount(a))
  if (threads.length === 0) throw new Error('no renderer main thread in the trace')
  return threads[0]
}

function sumDur(acc: number, e: TraceEvent): number {
  return acc + (e.dur ?? 0)
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}
