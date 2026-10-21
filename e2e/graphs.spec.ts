import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { openWorkspace, panelEval, quitApp, waitForPaletteSelection } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

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
const click = (app: ElectronApplication, selector: string, label: string) =>
  panelEval(
    app,
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.trim() === ${JSON.stringify(label)}); el?.click(); return el ? 'ok' : 'missing' })()`,
  )

async function openPanel(win: Page): Promise<void> {
  await win.keyboard.press(chords.palette)
  await win.locator('[data-slot="command-input"]').fill('Graphs: Open Panel')
  await waitForPaletteSelection(win, 'Graphs: Open Panel')
  await win.keyboard.press('Enter')
}

function seed(home: string, files: Record<string, string>): void {
  mkdirSync(join(home, '.ostia/graphs'), { recursive: true })
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(home, '.ostia/graphs', `${name}.yaml`), body)
}

test('GRF-C140 GRF-C141 GRF-C142 GRF-C58 the Graphs panel lists, enables, runs and inspects a graph', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const bin = fakeAgentBin(dataHome)
  seed(launch.home, { ready: READY })
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH ?? ''}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await openPanel(win)
    await expect
      .poll(() => text(app, '[data-graph] .ostia-row-title'), { timeout: 30_000 })
      .toBe('ready')
    expect(await attr(app, '[data-graph="ready"]', 'data-state')).toBe('not-enabled')
    expect(await text(app, '.note')).toBe('')

    await click(app, '[data-graph="ready"] button', 'Look and enable')
    await expect
      .poll(() => text(app, '[data-node="work"]'), { timeout: 15_000 })
      .toContain('Fix {{state.task}}')
    expect(await text(app, '[data-edge="build>ask"]')).toContain('when state.exit == 0')
    await click(app, 'button', 'Enable')
    await expect.poll(() => text(app, '.actions button'), { timeout: 15_000 }).toContain('Disable')
    await win.locator('#right-panel').getByRole('button', { name: 'Back' }).click()
    await expect
      .poll(() => attr(app, '[data-graph="ready"]', 'data-state'), { timeout: 15_000 })
      .toBe('enabled')

    await click(app, '[data-graph="ready"] button', 'Runs')
    await expect
      .poll(() => attr(app, '[data-empty]', 'data-empty'), { timeout: 15_000 })
      .toBe('runs')
    await win.locator('#right-panel').getByRole('button', { name: 'Back' }).click()
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

test('GRF-C140 a workspace with no graphs says just No graphs, with no title row, icon or path', async () => {
  const launch = isolatedLaunch(freshDataHome())
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await openPanel(win)
    await expect
      .poll(() => attr(app, '[data-empty]', 'data-empty'), { timeout: 30_000 })
      .toBe('folder')
    expect(await text(app, '.ostia-empty')).toBe('No graphs.')
    expect(await text(app, 'h1, .empty-path, .empty-media, svg')).toBe('')
    expect(await text(app, '.note')).toBe('')
  } finally {
    await quitApp(app)
  }
})
