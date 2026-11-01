import { cpSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, seedSettings } from '../dataHome'
import { openWorkspace, quitApp } from '../helpers'
import { test } from '../test'
import { firstContentfulPaint, launchPlain, launchProbed, SHOWN_INPUT, shownRows } from './flowApp'
import { Samples, WARMUP } from './flowResults'

const LAUNCHES = Number(process.env.OSTIA_FLOW_LAUNCHES ?? 10)
const KEYS = 100
const KEY_GAP_MS = 30
const SETTINGS = { behavior: { gpuAcceleration: false }, workspaces: { confirmQuit: false } }

interface TypingProbe {
  keys: number[]
  echoes: number[]
  longs: { start: number; dur: number }[]
}

function typingProbe(): void {
  const w = window as unknown as { __typing: TypingProbe }
  const probe: TypingProbe = { keys: [], echoes: [], longs: [] }
  w.__typing = probe
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      probe.longs.push({ start: performance.timeOrigin + e.startTime, dur: e.duration })
    }
  }).observe({ type: 'longtask', buffered: true })
  document.addEventListener(
    'keydown',
    (e) => probe.keys.push(performance.timeOrigin + e.timeStamp),
    true,
  )
  const length = () =>
    [...document.querySelectorAll('.terminal-text')]
      .filter((el) => !el.closest('[data-hidden]'))
      .reduce((sum, el) => sum + (el.textContent?.length ?? 0), 0)
  let last = length()
  new MutationObserver(() => {
    const now = length()
    if (now === last) return
    last = now
    requestAnimationFrame((t) => probe.echoes.push(performance.timeOrigin + t))
  }).observe(document, { subtree: true, childList: true, characterData: true })
}

test('bench typing: keys typed from the first paint wait for nothing', async () => {
  test.setTimeout(600_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, SETTINGS)
  const seed = await launchPlain(dataHome)
  try {
    await openWorkspace(seed.win)
    await seed.win.waitForTimeout(1_000)
  } finally {
    await quitApp(seed.app)
  }
  const snapshot = `${dataHome}-snapshot`
  cpSync(dataHome, snapshot, { recursive: true })
  const samples = new Samples()
  for (let i = 0; i < LAUNCHES + WARMUP; i++) {
    for (const name of readdirSync(dataHome))
      rmSync(join(dataHome, name), { recursive: true, force: true })
    cpSync(snapshot, dataHome, { recursive: true })
    const { app, win } = await launchProbed(dataHome, {
      prompt: [shownRows('[❯$%#]')],
      focus: [SHOWN_INPUT],
    })
    try {
      await win.evaluate(typingProbe)
      await win.keyboard.type('x'.repeat(KEYS), { delay: KEY_GAP_MS })
      await win.waitForTimeout(500)
      const flow = await win.evaluate(() =>
        (window as unknown as { __flow: { read: () => Record<string, number> } }).__flow.read(),
      )
      const probe = await win.evaluate(
        () => (window as unknown as { __typing: TypingProbe }).__typing,
      )
      const fcp = await firstContentfulPaint(win)
      if (i < WARMUP) continue
      const ready = Math.max(flow.prompt, flow.focus)
      for (const key of probe.keys.filter((k) => k >= ready)) {
        const echo = probe.echoes.find((e) => e >= key)
        if (echo !== undefined) samples.add('typing.key-echo', echo - key)
      }
      const after = probe.longs.filter((l) => l.start >= fcp)
      const inside = probe.keys
        .filter((k) => k >= ready)
        .filter((k) => after.some((l) => k >= l.start && k <= l.start + l.dur))
      samples.add('typing.keys-inside-long-task', inside.length)
      samples.add(
        'typing.long-task-start-after-paint',
        Math.min(...after.map((l) => l.start)) - fcp,
      )
      samples.add('typing.ready-after-paint', ready - fcp)
      samples.add('typing.longest-task-after-paint', Math.max(0, ...after.map((l) => l.dur)))
      samples.add(
        'typing.long-task-total-after-paint',
        after.reduce((sum, l) => sum + l.dur, 0),
      )
    } finally {
      await quitApp(app)
    }
  }
  samples.flush()
})
