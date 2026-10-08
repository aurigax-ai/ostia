import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { BENCH_ENGINES } from './ghostty'
import { newTerminal } from './helpers'
import { processRows } from './processes'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const PANES = 10
const SETTLE_S = 20
const IDLE_S = 60
const LOAD_S = 60
const AFTER_S = 60
const SAMPLE_S = 10
interface Proc {
  pid: number
  ppid: number
  rssKb: number
  cpuS: number
  comm: string
  cat: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function cpuSeconds(t: string): number {
  const [rest, frac = '0'] = t.split('.')
  let s = 0
  for (const part of rest.split(/[:-]/).map(Number)) s = s * 60 + part
  return s + Number(`0.${frac}`)
}

function tree(rootPid: number): Omit<Proc, 'cat'>[] {
  return processRows(rootPid, 'rss=,time=,comm=').map(({ pid, ppid, fields }) => ({
    pid,
    ppid,
    rssKb: Number(fields[0]),
    cpuS: cpuSeconds(fields[1]),
    comm: fields.slice(2).join(' '),
  }))
}

async function classify(app: ElectronApplication, rootPid: number): Promise<Proc[]> {
  const metrics = await app.evaluate(({ app: a }) =>
    a
      .getAppMetrics()
      .map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? m.serviceName ?? '' })),
  )
  const byPid = new Map(metrics.map((m) => [m.pid, m]))
  return tree(rootPid).map((p) => {
    const m = byPid.get(p.pid)
    let cat: string
    if (m) cat = m.type === 'Utility' ? `utility: ${m.name}` : m.type
    else if (/zsh|login/.test(p.comm)) cat = 'shell'
    else if (p.comm === 'perl') cat = 'load (perl)'
    else cat = `other: ${p.comm}`
    return { ...p, cat }
  })
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

async function phase(app: ElectronApplication, rootPid: number, seconds: number) {
  const samples: { t: number; procs: Proc[] }[] = []
  const take = async () => samples.push({ t: Date.now(), procs: await classify(app, rootPid) })
  await take()
  for (let i = 0; i < seconds / SAMPLE_S; i++) {
    await sleep(SAMPLE_S * 1000)
    await take()
  }
  const first = samples[0]
  const last = samples[samples.length - 1]
  const wall = (last.t - first.t) / 1000
  const start = new Map(first.procs.map((p) => [p.pid, p.cpuS]))
  const lastSeen = new Map<number, Proc>()
  for (const s of samples) for (const p of s.procs) lastSeen.set(p.pid, p)
  const cpuBy: Record<string, number> = {}
  let treeCpu = 0
  for (const p of lastSeen.values()) {
    const d = p.cpuS - (start.get(p.pid) ?? 0)
    treeCpu += d
    cpuBy[p.cat] = (cpuBy[p.cat] ?? 0) + d
  }
  const rss = (s: { procs: Proc[] }, f: (p: Proc) => boolean) =>
    s.procs.filter(f).reduce((a, p) => a + p.rssKb, 0) / 1024
  const cats = [...new Set(samples.flatMap((s) => s.procs.map((p) => p.cat)))]
  const breakdown: Record<string, string> = {}
  for (const c of cats) {
    const cpu = (((cpuBy[c] ?? 0) / wall) * 100).toFixed(1)
    const mem = median(samples.map((s) => rss(s, (p) => p.cat === c))).toFixed(0)
    breakdown[c] = `${cpu}% / ${mem} MB`
  }
  return {
    treeCpuPct: +((treeCpu / wall) * 100).toFixed(1),
    treeRssMedian: +median(samples.map((s) => rss(s, () => true))).toFixed(0),
    treeRssPeak: +Math.max(...samples.map((s) => rss(s, () => true))).toFixed(0),
    breakdown,
  }
}

for (const engine of BENCH_ENGINES) {
  test(`bench ${engine.name} resources`, async () => {
    test.setTimeout(15 * 60_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, { ...engine.settings, workspaces: { confirmQuit: false } })
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
    const rootPid = app.process().pid ?? 0
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await newTerminal(win)
      const surfaces = win.locator('.xterm-host, .ghostty-host')
      let count = 1
      await expect(surfaces).toHaveCount(count, { timeout: 15_000 })
      const split = async (name: string) => {
        await win.locator('.pane.active').getByRole('button', { name }).click()
        count++
        await expect(surfaces).toHaveCount(count, { timeout: 15_000 })
      }
      await split('Split down')
      for (let i = 0; i < PANES / 2 - 1; i++) await split('Split right')
      await surfaces.first().click()
      for (let i = 0; i < PANES / 2 - 1; i++) await split('Split right')
      await expect
        .poll(() => tree(rootPid).filter((p) => p.comm === 'zsh').length, { timeout: 60_000 })
        .toBeGreaterThanOrEqual(PANES)
      await sleep(SETTLE_S * 1000)

      const idle = await phase(app, rootPid, IDLE_S)
      const doneDir = join(dataHome, 'done')
      mkdirSync(doneDir, { recursive: true })
      const loadCmd = `perl -e '$|=1; for my $t (1..${LOAD_S * 20}) { print "ostia-load $t " . ("x" x 100) . "\\n" for 1..20; select(undef,undef,undef,0.05) }'; : > ${doneDir}/done-$$`
      for (let i = 0; i < PANES; i++) {
        await surfaces.nth(i).click()
        await win.keyboard.type(loadCmd)
        await win.keyboard.press('Enter')
      }
      const load = await phase(app, rootPid, LOAD_S)
      await expect.poll(() => readdirSync(doneDir).length, { timeout: 120_000 }).toBe(PANES)
      await sleep(15_000)
      const after = await phase(app, rootPid, AFTER_S)
      console.log(`BENCH ${engine.name} resources ${JSON.stringify({ idle, load, after })}`)
    } finally {
      await app.close()
    }
  })
}
