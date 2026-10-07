import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'
import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, emptyWorkspace } from './helpers'

const PANES = 10
const SETTLE_S = 20
const IDLE_S = 60
const LOAD_S = 60
const AFTER_S = 60
const SAMPLE_S = 10
const OUT = process.env.M158_OUT ?? '/tmp/gw-probe/m158'

const ENGINES = [
  { name: 'xterm-webgl', settings: { behavior: { gpuAcceleration: true } } },
  {
    name: 'ghostty-gpu',
    settings: { behavior: { gpuAcceleration: true }, terminal: { renderer: 'ghostty' } },
  },
  { name: 'xterm-dom', settings: { behavior: { gpuAcceleration: false } } },
  {
    name: 'ghostty-canvas',
    settings: { behavior: { gpuAcceleration: false }, terminal: { renderer: 'ghostty' } },
  },
]

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
  const all = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rssKb: +m[3], cpuS: cpuSeconds(m[4]), comm: m[5] }))
  const keep = new Set([rootPid])
  let grew = true
  while (grew) {
    grew = false
    for (const p of all) {
      if (!keep.has(p.pid) && keep.has(p.ppid)) {
        keep.add(p.pid)
        grew = true
      }
    }
  }
  return all.filter((p) => keep.has(p.pid))
}

async function classify(app: ElectronApplication, rootPid: number): Promise<Proc[]> {
  const metrics = await app.evaluate(({ app: a }) =>
    a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? m.serviceName ?? '' })),
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

for (const engine of ENGINES) {
  test(`m158 ${engine.name}`, async () => {
    test.setTimeout(15 * 60_000)
    mkdirSync(OUT, { recursive: true })
    const dataHome = freshDataHome()
    seedSettings(dataHome, { ...engine.settings, workspaces: { confirmQuit: false } })
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
    const rootPid = app.process().pid ?? 0
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await emptyState(win)
        .getByRole('button', { name: /New workspace/ })
        .click()
      await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
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
      await expect
        .poll(() => readdirSync(doneDir).length, { timeout: 120_000 })
        .toBe(PANES)
      await sleep(15_000)
      const after = await phase(app, rootPid, AFTER_S)
      const row = { engine: engine.name, idle, load, after }
      appendFileSync(join(OUT, 'results.jsonl'), `${JSON.stringify(row)}\n`)
      console.log(`M158 ${JSON.stringify(row)}`)
    } finally {
      await app.close()
    }
  })
}
