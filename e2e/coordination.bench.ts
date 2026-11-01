import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

const WORKER = `
const { spawnSync } = require('node:child_process')
const { appendFileSync, readFileSync, writeFileSync, existsSync } = require('node:fs')
const ostia = (...args) =>
  spawnSync(process.env.OSTIA_NODE, [process.env.OSTIA_CLI, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
  })
const { setTimeout: sleep } = require('node:timers/promises')
const counter = process.env.BENCH_COUNTER
const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1
writeFileSync(counter, String(n))
ostia('resume-token', 'claude', 'bench-' + process.pid)
ostia('state', 'working')
const run = async () => {
  for (let i = 1; i <= 4; i++) {
    process.stdout.write('$ pnpm test --step ' + i + '\\r\\n')
    for (let line = 0; line < 30; line++) {
      process.stdout.write('  ok  packages/module-' + i + '/case-' + line + '.test.ts (' + (line * 3 + 11) + ' ms)\\r\\n')
    }
    await sleep(1500)
  }
  if (n % 3 === 2) {
    ostia('state', 'waiting', 'Approve the migration?')
    await sleep(2500)
    ostia('state', 'working')
  }
  ostia('state', 'done', 'PR #' + (1000 + n) + ' open, unit tests green')
}
void run()
setInterval(() => {}, 1_000_000)
`

const DRIVER = `
const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const ostia = (...args) =>
  spawnSync(process.env.OSTIA_NODE, [process.env.OSTIA_CLI, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  })
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const size = (res) => Buffer.byteLength(res.stdout ?? '') + Buffer.byteLength(res.stderr ?? '')
const names = (prefix) => [0, 1, 2].map((i) => prefix + i)
const allDone = () => {
  const listed = ostia('pane', 'list')
  const panes = JSON.parse(listed.stdout)
  const mine = panes.filter((p) => (p.agentSessionId ?? '').startsWith('bench-'))
  return { listed, done: mine.length === 3 && mine.every((p) => p.agentState === 'done') }
}
const start = (prefix) => {
  let written = 0
  for (const name of names(prefix)) {
    const args = ['agent', 'run', 'claude', 'go', '--name', name]
    written += args.join(' ').length
    ostia(...args)
  }
  return written
}
const result = {}

{
  const channels = { 'pane.list': 0, 'pane.read': 0, written: start('old') }
  let polls = 0
  for (;;) {
    sleep(2000)
    polls += 1
    const { listed, done } = allDone()
    channels['pane.list'] += size(listed)
    channels.written += 'pane list'.length
    for (const name of names('old')) {
      channels['pane.read'] += size(ostia('pane', 'read', name, '--lines', '30'))
      channels.written += ('pane read ' + name + ' --lines 30').length
    }
    if (done || polls > 60) break
  }
  result.old = { polls, channels }
}

{
  const channels = { 'pane.watch': 0, 'bus.wait': 0, 'pane.status': 0, written: start('new') }
  const watch = ostia('pane', 'watch', ...names('new'), '--until', 'done')
  channels['pane.watch'] += size(watch)
  channels.written += ('pane watch ' + names('new').join(' ') + ' --until done').length
  let events = 0
  let waits = 0
  while (events < 3 && waits < 60) {
    const res = ostia('bus', 'wait', '--timeout', '20')
    waits += 1
    channels['bus.wait'] += size(res)
    channels.written += 'bus wait --timeout 20'.length
    events += res.stdout.split('<message ').length - 1
  }
  const status = ostia('pane', 'status', ...names('new'))
  channels['pane.status'] += size(status)
  channels.written += ('pane status ' + names('new').join(' ')).length
  result.new = { polls: waits, events, channels }
}

writeFileSync(process.env.BENCH_OUT, JSON.stringify(result))
process.stdout.write('bench-driver-finished\\r\\n')
`

function total(channels: Record<string, number>): number {
  return Object.values(channels).reduce((sum, n) => sum + n, 0)
}

test('bench coordination: polling a worker with pane read versus pane watch and pane status', async () => {
  test.setTimeout(240_000)
  const dataHome = freshDataHome()
  const worker = join(dataHome, 'worker.cjs')
  const driver = join(dataHome, 'driver.cjs')
  const out = join(dataHome, 'bench-out.json')
  writeFileSync(worker, WORKER)
  writeFileSync(driver, DRIVER)
  const bin = fakeAgentBin(
    dataHome,
    `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "${worker}"\n`,
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      HOME: isolatedHome(dataHome),
      PATH: `${bin}:${launch.env.PATH ?? ''}`,
      BENCH_COUNTER: join(dataHome, 'counter'),
      BENCH_OUT: out,
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.ghostty-host').first().click()
    await typeLine(win, `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" ${driver}`)
    await expect(win.locator('.terminal-text').first()).toContainText('bench-driver-finished', {
      timeout: 200_000,
    })
    const result = JSON.parse(readFileSync(out, 'utf8')) as {
      old: { polls: number; channels: Record<string, number> }
      new: { polls: number; events: number; channels: Record<string, number> }
    }
    const old = total(result.old.channels)
    const next = total(result.new.channels)
    console.log(`BENCH coordination old ${JSON.stringify({ ...result.old, total: old })}`)
    console.log(`BENCH coordination new ${JSON.stringify({ ...result.new, total: next })}`)
    console.log(
      `BENCH coordination ratio ${JSON.stringify({ bytesNewOverOld: Math.round((next / old) * 1000) / 1000 })}`,
    )
    expect(result.new.events).toBe(3)
    expect(next).toBeLessThan(old)
  } finally {
    await app.close()
  }
})
