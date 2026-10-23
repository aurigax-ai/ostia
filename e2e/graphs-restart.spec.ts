import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { extensionHosts } from './extensionHosts'
import { guestKeys, pressInPage } from './guestKeys'
import { openWorkspace, panelEval, quitApp, showInbox, waitForPaletteSelection } from './helpers'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  killApp,
  type Page,
  test,
} from './test'

test.describe.configure({ timeout: 240_000 })

const clickLabel = (app: ElectronApplication, selector: string, label: string) =>
  panelEval(
    app,
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.trim() === ${JSON.stringify(label)}); el?.click(); return el ? 'ok' : 'missing' })()`,
  )

async function choosePanel(win: Page): Promise<void> {
  await win.locator('[data-slot="command-input"]').fill('Graphs: Open Panel')
  await waitForPaletteSelection(win, 'Graphs: Open Panel')
  await win.keyboard.press('Enter')
}

async function openPanel(win: Page): Promise<void> {
  await win.keyboard.press(chords.palette)
  await choosePanel(win)
}

async function kill(app: ElectronApplication): Promise<void> {
  await killApp(app)
}

async function enableAndRun(app: ElectronApplication, win: Page, name: string): Promise<void> {
  await expect
    .poll(() => clickLabel(app, `[data-graph="${name}"] button`, 'Look and enable'), {
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
    .poll(() => clickLabel(app, `[data-graph="${name}"] button`, 'Run now'), { timeout: 15_000 })
    .toBe('ok')
  await win.locator('#right-panel').getByRole('button', { name: 'Back' }).click()
}

test('GRF-C59 GRF-C70 a waiting approval and a cut-off command come back after Ostia is killed', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const log = join(dataHome, 'steps.log')
  mkdirSync(join(launch.home, '.ostia/graphs'), { recursive: true })
  writeFileSync(
    join(launch.home, '.ostia/graphs/asked.yaml'),
    `version: 1
on: [{ manual: {} }]
start: first
state: { decision: { type: string, default: "" } }
nodes:
  - { id: first, kind: command, with: { run: [sh, -c, "echo first >> ${log}"] } }
  - { id: ask, kind: approval, with: { question: "Keep going after the restart?" }, out: { answer: decision } }
  - { id: last, kind: command, with: { run: [sh, -c, "echo last >> ${log}"] } }
edges:
  - { from: first, to: ask }
  - { from: ask, to: last }
`,
  )
  writeFileSync(
    join(launch.home, '.ostia/graphs/cut.yaml'),
    `version: 1
on: [{ manual: {} }]
start: before
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: before, kind: command, with: { run: [sh, -c, "echo before >> ${log}"] } }
  - { id: slow, kind: command, timeout: 5m, with: { run: [sh, -c, "echo slow $GRAPH_ATTEMPT $GRAPH_ATTEMPT_KEY >> ${log}; sleep 3"] } }
edges:
  - { from: before, to: slow }
`,
  )
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])

  let app = await electron.launch(launch)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await openPanel(win)
  await enableAndRun(app, win, 'asked')
  await win.keyboard.press(chords.palette)
  const inbox = await showInbox(win)
  await expect(
    inbox.locator('article[data-question]', { hasText: 'Keep going after the restart?' }),
  ).toBeVisible({ timeout: 30_000 })
  await win.locator('.topbar').getByRole('button', { name: 'Graphs', exact: true }).click()
  await enableAndRun(app, win, 'cut')
  await expect
    .poll(() => lines().filter((l) => l.startsWith('slow')).length, { timeout: 30_000 })
    .toBe(1)
  await kill(app)

  app = await electron.launch(launch)
  try {
    const again = await app.firstWindow()
    await again.waitForLoadState('domcontentloaded')
    await expect(again.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => panelEval(app, 'document.readyState'), { timeout: 30_000 })
      .toBe('complete')
    await pressInPage(app, guestKeys.palette)
    await choosePanel(again)
    await pressInPage(app, guestKeys.palette)
    const inbox = await showInbox(again)
    const card = inbox.locator('article[data-question]', {
      hasText: 'Keep going after the restart?',
    })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('radio', { name: 'Approve' }).check()
    await card.getByRole('button', { name: 'Send' }).click()
    await expect.poll(() => lines().filter((l) => l === 'last').length, { timeout: 30_000 }).toBe(1)
    await expect
      .poll(() => lines().filter((l) => l.startsWith('slow')).length, { timeout: 30_000 })
      .toBe(2)
    const slow = lines()
      .filter((l) => l.startsWith('slow'))
      .map((l) => l.split(' '))
    expect(slow.map((s) => s[1])).toEqual(['1', '2'])
    expect(slow[0]?.[2]).toBe(slow[1]?.[2])
    expect(lines().filter((l) => l === 'first')).toHaveLength(1)
    expect(lines().filter((l) => l === 'before')).toHaveLength(1)
  } finally {
    await quitApp(app)
  }
})

test('a waiting run outlives its closed panel tab and starts the graphs host with the next window', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  mkdirSync(join(launch.home, '.ostia/graphs'), { recursive: true })
  writeFileSync(
    join(launch.home, '.ostia/graphs/held.yaml'),
    `version: 1
on: [{ manual: {} }]
start: ask
state: { n: { type: integer, default: 0 } }
nodes:
  - { id: ask, kind: approval, with: { question: "Still waiting after the restart?" } }
edges: []
`,
  )

  let app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await openPanel(win)
    await enableAndRun(app, win, 'held')
    await win.locator('.topbar').getByRole('button', { name: 'Graphs', exact: true }).click()
    await expect(win.locator('#right-panel')).toHaveAttribute('data-hidden', '')
    await win.keyboard.press(chords.palette)
    const inbox = await showInbox(win)
    await expect(
      inbox.locator('article[data-question]', { hasText: 'Still waiting after the restart?' }),
    ).toBeVisible({ timeout: 30_000 })
  } finally {
    await quitApp(app)
  }

  app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => extensionHosts(app), { timeout: 30_000 }).toContain('graphs')
    await win.keyboard.press(chords.palette)
    const inbox = await showInbox(win)
    const card = inbox.locator('article[data-question]', {
      hasText: 'Still waiting after the restart?',
    })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole('radio', { name: 'Approve' }).check()
    await card.getByRole('button', { name: 'Send' }).click()
    await expect(card).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await quitApp(app)
  }
})
