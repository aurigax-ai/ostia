import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import {
  CANVAS_RENDERER_SETTINGS,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
  wireDataDir,
} from './dataHome'
import { openWorkspace, panelEval, quitApp, restartApp, waitForPaletteSelection } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 240_000 })

const KEEP = { ...CANVAS_RENDERER_SETTINGS, terminal: { keepShells: true } }

const AGENT = (log: string, go: string, report: boolean) => `
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const plugin = args[args.indexOf('--plugin-dir') + 1]
const prompt = args[args.length - 1]
const run = (/--run (\\S+)/.exec(prompt) || [])[1]
const hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks
const fire = (event, payload) => {
  for (const group of hooks[event] || [])
    for (const hook of group.hooks) {
      try {
        execFileSync('sh', ['-c', hook.command], { input: JSON.stringify(payload), stdio: ['pipe', 'ignore', 'ignore'] })
      } catch {}
    }
}
fire('SessionStart', { session_id: 'e2e-graph', source: 'startup', cwd: process.cwd() })
fire('UserPromptSubmit', { session_id: 'e2e-graph', prompt: 'fix it' })
appendFileSync(${JSON.stringify(log)}, 'start\\n')
console.log('fake-agent-ready')
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(go)})) return
  clearInterval(timer)
  if (${report}) {
    execFileSync(process.env.OSTIA_NODE, [process.env.OSTIA_CLI, 'graph', 'report', '--json', '{"v":"after"}', '--run', run], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    })
  }
  fire('Stop', { session_id: 'e2e-graph', last_assistant_message: 'Closing words from while Ostia was closed' })
  appendFileSync(${JSON.stringify(log)}, 'stopped\\n')
}, 200)
setInterval(() => {}, 1 << 30)
`

const GRAPH = `version: 1
on: [{ manual: {} }]
start: work
state: { v: { type: string, default: "" } }
nodes:
  - { id: work, kind: agent, with: { mode: start, agent: claude, prompt: "Fix it." }, result: { type: object, properties: { v: { type: string } }, required: [v] }, out: { result.v: v } }
edges: []
`

type Line = Record<string, unknown> & { type: string }

function setup(report: boolean) {
  const dataHome = freshDataHome()
  seedSettings(dataHome, KEEP)
  const launch = isolatedLaunch(dataHome)
  const log = join(dataHome, 'agent.log')
  const go = join(dataHome, 'go')
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(dataHome, 'agent.js'), AGENT(log, go, report))
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" ${JSON.stringify(join(dataHome, 'agent.js'))} "$@"\n`,
  )
  chmodSync(join(bin, 'claude'), 0o755)
  mkdirSync(join(launch.home, '.ostia/graphs'), { recursive: true })
  writeFileSync(join(launch.home, '.ostia/graphs/kept.yaml'), GRAPH)
  const env = { ...launch.env, PATH: `${bin}:${launch.env.PATH ?? ''}` }
  const lines = (): Line[] => {
    const root = join(wireDataDir(dataHome), 'runs')
    if (!existsSync(root)) return []
    for (const scope of readdirSync(root)) {
      const folder = join(root, scope, 'kept')
      if (!existsSync(folder)) continue
      for (const run of readdirSync(folder)) {
        return readFileSync(join(folder, run, 'journal.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Line)
      }
    }
    return []
  }
  const logged = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  return { launch, env, go, lines, logged }
}

const clickLabel = (app: ElectronApplication, selector: string, label: string) =>
  panelEval(
    app,
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.trim() === ${JSON.stringify(label)}); el?.click(); return el ? 'ok' : 'missing' })()`,
  )

async function startRun(app: ElectronApplication, win: Page): Promise<void> {
  await win.keyboard.press(chords.palette)
  await win.locator('[data-slot="command-input"]').fill('Graphs: Open Panel')
  await waitForPaletteSelection(win, 'Graphs: Open Panel')
  await win.keyboard.press('Enter')
  await expect
    .poll(() => clickLabel(app, '[data-graph="kept"] button', 'Look and enable'), {
      timeout: 30_000,
    })
    .toBe('ok')
  await expect.poll(() => clickLabel(app, 'button', 'Enable'), { timeout: 15_000 }).toBe('ok')
  await expect
    .poll(() => panelEval(app, `document.body.innerText.includes('Disable') ? 'yes' : ''`), {
      timeout: 15_000,
    })
    .toBe('yes')
  await win.locator('#right-panel').getByRole('button', { name: 'Back' }).click()
  await expect
    .poll(() => clickLabel(app, '[data-graph="kept"] button', 'Run now'), { timeout: 15_000 })
    .toBe('ok')
}

test('GRF-C71 an agent still working in its kept pane across a restart is reattached as running and its report ends the node', async () => {
  const { launch, env, go, lines, logged } = setup(true)
  const first = await electron.launch({ ...launch, env })
  const win = await first.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await startRun(first, win)
  await expect
    .poll(() => lines().some((l) => l.type === 'node-wait' && l.node === 'work'), {
      timeout: 30_000,
    })
    .toBe(true)
  await expect.poll(logged, { timeout: 30_000 }).toEqual(['start'])
  await restartApp(first, win)

  const second = await electron.launch({ ...launch, env })
  try {
    const again = await second.firstWindow()
    await again.waitForLoadState('domcontentloaded')
    await expect
      .poll(() => lines().find((l) => l.type === 'reattach')?.verdict, { timeout: 60_000 })
      .toBe('running')
    writeFileSync(go, '')
    await expect
      .poll(() => lines().some((l) => l.type === 'run-end'), { timeout: 60_000 })
      .toBe(true)
    const end = lines().find((l) => l.type === 'node-end' && l.node === 'work')
    expect(end, JSON.stringify(lines())).toMatchObject({ status: 'done' })
    expect(JSON.stringify(end)).toContain('"v":"after"')
    expect(lines().filter((l) => l.type === 'node-start' && l.node === 'work')).toHaveLength(1)
    expect(logged()).toEqual(['start', 'stopped'])
  } finally {
    await quitApp(second)
  }
})

test('GRF-C167 an agent that stopped while Ostia was closed is reattached as done and the node raises NoResult', async () => {
  const { launch, env, go, lines, logged } = setup(false)
  const first = await electron.launch({ ...launch, env })
  const win = await first.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await startRun(first, win)
  await expect
    .poll(() => lines().some((l) => l.type === 'node-wait' && l.node === 'work'), {
      timeout: 30_000,
    })
    .toBe(true)
  await expect.poll(logged, { timeout: 30_000 }).toEqual(['start'])
  await restartApp(first, win)
  writeFileSync(go, '')
  await expect.poll(logged, { timeout: 30_000 }).toEqual(['start', 'stopped'])

  const second = await electron.launch({ ...launch, env })
  try {
    const again = await second.firstWindow()
    await again.waitForLoadState('domcontentloaded')
    await expect
      .poll(() => lines().find((l) => l.type === 'reattach')?.verdict, { timeout: 60_000 })
      .toBe('done')
    await expect
      .poll(() => lines().some((l) => l.type === 'run-end'), { timeout: 60_000 })
      .toBe(true)
    const end = lines().find((l) => l.type === 'node-end' && l.node === 'work')
    expect(JSON.stringify(end)).toContain('NoResult')
    expect(JSON.stringify(lines())).not.toContain('Closing words from while Ostia was closed')
    expect(lines().filter((l) => l.type === 'node-start' && l.node === 'work')).toHaveLength(1)
  } finally {
    await quitApp(second)
  }
})
