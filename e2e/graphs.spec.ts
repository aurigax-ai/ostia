import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { openWorkspace, quitApp, waitForPaletteSelection } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 180_000 })

const READY = `version: 1
description: Ask, then start an agent
on: [{ manual: { agents: true } }]
start: build
state:
  exit: { type: integer, default: -1 }
  task: { type: string, default: "the cart total" }
nodes:
  - { id: build, kind: command, with: { run: [sh, -c, "exit 0"] }, out: { exit: exit } }
  - { id: ask, kind: approval, with: { question: "Start the agent on {{state.task}}?" } }
  - { id: work, kind: agent, with: { mode: start, agent: claude, prompt: "Fix {{state.task}}" } }
edges:
  - from: build
    when: [{ if: "state.exit == 0", to: ask }]
    else: end
  - { from: ask, to: work }
`

const CHANGED = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: notify, with: { title: "before" } }
edges: []
`

const INVALID = `version: 1
on: [{ manual: {} }]
start: a
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: a, kind: nope }
edges: []
`

function panelEval(app: ElectronApplication, script: string): Promise<string> {
  return app.evaluate(async ({ webContents }, code) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
    return guest ? String(await guest.executeJavaScript(code)) : ''
  }, script)
}

const attr = (app: ElectronApplication, selector: string, name: string) =>
  panelEval(
    app,
    `document.querySelector(${JSON.stringify(selector)})?.getAttribute('${name}') ?? ''`,
  )
const text = (app: ElectronApplication, selector: string) =>
  panelEval(
    app,
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.innerText).join('|')`,
  )
const click = (app: ElectronApplication, selector: string, label?: string) =>
  panelEval(
    app,
    `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = ${
      label ? `els.find((e) => e.innerText.trim() === ${JSON.stringify(label)})` : 'els[0]'
    }; el?.click(); return el ? 'ok' : 'missing' })()`,
  )

async function palette(win: Page, query: string, pick?: string): Promise<void> {
  await win.keyboard.press('Control+Shift+P')
  await win.locator('[data-slot="command-input"]').fill(query)
  if (pick) {
    await waitForPaletteSelection(win, pick)
    await win.keyboard.press('Enter')
  }
}

function seed(home: string, files: Record<string, string>): void {
  mkdirSync(join(home, '.ostia/graphs'), { recursive: true })
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(home, '.ostia/graphs', `${name}.yaml`), body)
}

test('GRF-C140 GRF-C141 GRF-C142 GRF-C81 GRF-C58 the Graphs panel lists, enables, runs and inspects graphs, and shows empty states', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const bin = fakeAgentBin(dataHome)
  const env = { ...launch.env, PATH: `${bin}:${launch.env.PATH ?? ''}` }

  let app = await electron.launch({ ...launch, env })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await palette(win, 'Graphs: Open Panel', 'Graphs: Open Panel')
    await expect
      .poll(() => attr(app, '[data-empty]', 'data-empty'), { timeout: 30_000 })
      .toBe('folder')
    expect(await text(app, '[data-empty]')).toContain(join(launch.home, '.ostia/graphs'))
    expect(await text(app, '.note')).toContain('while Ostia is open')
  } finally {
    await quitApp(app)
  }

  seed(launch.home, { ready: READY, changed: CHANGED, invalid: INVALID })
  app = await electron.launch({ ...launch, env })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await palette(win, 'Graphs: Open Panel', 'Graphs: Open Panel')
    await expect
      .poll(() => text(app, '.row .name'), { timeout: 30_000 })
      .toBe('changed|invalid|ready')
    expect(await attr(app, '[data-graph="ready"]', 'data-state')).toBe('not-enabled')
    expect(await attr(app, '[data-graph="invalid"]', 'data-state')).toBe('invalid')
    expect(await text(app, '[data-graph="invalid"] [data-problem]')).toContain('unknown-kind (a)')

    await click(app, '[data-graph="changed"] button', 'Look and enable')
    await expect.poll(() => text(app, '[data-node="a"]'), { timeout: 15_000 }).toContain('before')
    await click(app, 'button', 'Enable')
    await expect.poll(() => text(app, '.actions button'), { timeout: 15_000 }).toContain('Disable')
    await click(app, 'button', 'Back')
    await expect
      .poll(() => attr(app, '[data-graph="changed"]', 'data-state'), { timeout: 15_000 })
      .toBe('enabled')
    writeFileSync(
      join(launch.home, '.ostia/graphs/changed.yaml'),
      CHANGED.replace('before', 'after'),
    )
    await click(app, '[data-graph="ready"] button', 'Look and enable')
    await expect.poll(() => text(app, '[data-node="work"]'), { timeout: 15_000 }).toContain('Fix')
    await click(app, 'button', 'Back')
    await expect
      .poll(() => attr(app, '[data-graph="changed"]', 'data-state'), { timeout: 15_000 })
      .toBe('changed')
    expect(await text(app, '[data-graph="changed"] .state')).toContain('Changed, enable again')

    await click(app, '[data-graph="ready"] button', 'Look and enable')
    await expect
      .poll(() => text(app, '[data-node="work"]'), { timeout: 15_000 })
      .toContain('Fix {{state.task}}')
    expect(await text(app, '[data-node="build"]')).toContain('"exit 0"')
    expect(await text(app, '[data-node="ask"]')).toContain('Start the agent on {{state.task}}?')
    expect(await text(app, '[data-edge="build>ask"]')).toContain('when state.exit == 0')
    expect(await text(app, '[data-trigger="manual"]')).toContain('agents may start this')
    await click(app, 'button', 'Enable')
    await expect.poll(() => text(app, '.actions button'), { timeout: 15_000 }).toContain('Disable')
    await click(app, 'button', 'Back')
    await expect
      .poll(() => attr(app, '[data-graph="ready"]', 'data-state'), { timeout: 15_000 })
      .toBe('enabled')

    await click(app, '[data-graph="ready"] button', 'Runs')
    await expect
      .poll(() => attr(app, '[data-empty]', 'data-empty'), { timeout: 15_000 })
      .toBe('runs')
    await click(app, 'button', 'Back')
    await expect
      .poll(() => text(app, '[data-graph="ready"] button'), { timeout: 15_000 })
      .toContain('Run now')
    await click(app, '[data-graph="ready"] button', 'Run now')
    await expect
      .poll(() => attr(app, '[data-node="ask"]', 'data-status'), { timeout: 30_000 })
      .toBe('waiting')
    expect(await attr(app, '[data-node="build"]', 'data-status')).toBe('done')

    await win.keyboard.press('Control+Shift+D')
    const card = win.locator('article[data-question]', {
      hasText: 'Start the agent on the cart total?',
    })
    await expect(card).toBeVisible({ timeout: 15_000 })
    await expect(card).toContainText('Graphs')
    await card.getByRole('radio', { name: 'Approve' }).check()
    await card.getByRole('button', { name: 'Send' }).click()

    await expect
      .poll(() => attr(app, '[data-node="work"]', 'data-status'), { timeout: 30_000 })
      .toBe('waiting')
    await expect
      .poll(() => text(app, '[data-node="work"] button'), { timeout: 15_000 })
      .toContain('Show pane')
    await click(app, '[data-node="work"] button', 'Show pane')
    await expect(
      win
        .locator('.pane-slot:not([data-hidden]) .xterm-rows', { hasText: 'fake-agent-ready' })
        .first(),
    ).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await quitApp(app)
  }
})

test('GRF-C149 the palette keeps the Git commit graph and Graphs apart', async () => {
  const launch = isolatedLaunch(freshDataHome())
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await palette(win, 'graph')
    const options = win.getByRole('option')
    await expect(options.filter({ hasText: 'Graphs: Open Panel' })).toHaveCount(1, {
      timeout: 15_000,
    })
    await expect(options.filter({ hasText: 'Show Graph' })).toHaveCount(1)
    const names = await options.allInnerTexts()
    const rows = names.map((n) => n.replace(/\s+/g, ' ').trim())
    expect(new Set(rows).size).toBe(rows.length)
    expect(rows.find((r) => r.includes('Show Graph'))).not.toContain('Graphs:')
  } finally {
    await quitApp(app)
  }
})
