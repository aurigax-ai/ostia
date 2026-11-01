import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type IncidentScenario, scenarioOf } from '../../test/incidentScenario'
import { freshDataHome, isolatedLaunch } from '../dataHome'
import { fakeAgentBin, isolatedHome } from '../fakeAgent'
import { openWorkspace, typeLine } from '../helpers'
import { _electron as electron, expect, test } from '../test'

const FAKE_AGENT = `
const { spawnSync } = require('node:child_process')
const ostia = (...args) =>
  spawnSync(process.env.OSTIA_NODE, [process.env.OSTIA_CLI, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
  })
const swallow = process.env.REPRO_SWALLOW_ENTER === '1'
const neverDone = process.env.REPRO_NEVER_DONE === '1'
ostia('resume-token', 'claude', 'repro-incident')
process.stdout.write('\\x1b[?2004hfake-agent-ready\\r\\n')
process.stdin.setRawMode(true)
let pending = ''
let afterPaste = false
let swallowed = false
process.stdin.on('data', (chunk) => {
  pending += chunk.toString()
  while (pending) {
    if (pending.startsWith('\\x1b[200~')) {
      const end = pending.indexOf('\\x1b[201~')
      if (end < 0) return
      process.stdout.write(pending.slice(6, end).replace(/\\r/g, '\\r\\n'))
      pending = pending.slice(end + 6)
      afterPaste = true
      continue
    }
    const key = pending[0]
    pending = pending.slice(1)
    if (key !== '\\r') {
      process.stdout.write(key)
      continue
    }
    if (swallow && afterPaste && !swallowed) {
      swallowed = true
      afterPaste = false
      process.stdout.write('\\r\\nswallowed-enter\\r\\n')
      continue
    }
    process.stdout.write('\\r\\nsubmitted\\r\\n')
    ostia('state', 'working')
    if (!neverDone) setTimeout(() => ostia('state', 'done'), 300)
  }
})
`

const REPLAY_NOTE =
  'This replays Ostia side only: its calls, timings and pane states against a fake agent. It cannot replay what a real agent did inside.'

function replayLine(scenario: IncidentScenario): string {
  return scenario.method === 'pane.input'
    ? "printf 'line one\\nline two' | ostia pane send worker - --enter; echo send-exit-$?"
    : 'ostia pane wait worker --until done --timeout 40 & echo wait-started'
}

test('replays an incident report against the built app', async () => {
  test.setTimeout(180_000)
  const file = process.env.OSTIA_REPRO_INCIDENT
  const resultFile = process.env.OSTIA_REPRO_RESULT
  expect(file, 'OSTIA_REPRO_INCIDENT names the report file').toBeTruthy()
  const parsed = scenarioOf(readFileSync(file as string, 'utf8'))
  const write = (result: object): void => {
    if (resultFile) writeFileSync(resultFile, JSON.stringify({ note: REPLAY_NOTE, ...result }))
  }
  if (!parsed.ok) {
    write({ verdict: 'unsupported', reason: parsed.reason })
    return
  }
  const { scenario } = parsed
  const dataHome = freshDataHome()
  const script = join(dataHome, 'fake-claude.cjs')
  writeFileSync(script, FAKE_AGENT)
  const bin = fakeAgentBin(
    dataHome,
    `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "${script}"\n`,
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      HOME: isolatedHome(dataHome),
      PATH: `${bin}:${launch.env.PATH ?? ''}`,
      REPRO_SWALLOW_ENTER: scenario.swallowEnter ? '1' : '0',
      REPRO_NEVER_DONE: scenario.silentAgent ? '1' : '0',
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const caller = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()
    await typeLine(win, 'ostia agent run claude go --name worker; echo run-exit-$?')
    await expect(caller).toContainText('run-exit-0', { timeout: 30_000 })
    if (scenario.draft) {
      await typeLine(win, 'ostia pane send worker "a draft"; echo draft-exit-$?')
      await expect(caller).toContainText('draft-exit-0', { timeout: 15_000 })
    }
    await typeLine(win, replayLine(scenario))
    await expect(caller).toContainText(
      scenario.method === 'pane.input' ? 'send-exit-' : 'wait-started',
      { timeout: 30_000 },
    )
    const observed = new Set<string>()
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !observed.has(scenario.trigger)) {
      const list = await win.evaluate(() => window.ostia.incidents.list())
      for (const item of list) observed.add(item.trigger)
      if (!observed.has(scenario.trigger)) await win.waitForTimeout(1000)
    }
    write({
      verdict: observed.has(scenario.trigger) ? 'reproduced' : 'not-reproduced',
      expected: scenario.trigger,
      observed: [...observed],
    })
  } finally {
    await app.close()
  }
})
