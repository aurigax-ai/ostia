import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import {
  CANVAS_RENDERER_SETTINGS,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
  testHome,
} from './dataHome'
import { expectHeld, shownTerminal, waitForPaletteSelection } from './helpers'
import { type ElectronApplication, expect, launchShared, type Page, test } from './test'

test.describe.configure({ mode: 'serial', timeout: 150_000 })

const CLOSING = 'Export test is flaky; next: rerun with --repeat 20'
const SHOWN_ROWS = '.pane-slot:not([data-hidden]) .terminal-text'
const WORKSPACE_KEY = process.platform === 'darwin' ? 'Meta' : 'Control'

interface Place {
  id: string
  name: string
  folder: string
}

let dataHome = ''
let app: ElectronApplication
let win: Page
let places: Record<'one' | 'two' | 'three', Place>
let log = ''
let release = ''

function resumes(session: string): number {
  if (!existsSync(log)) return 0
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.includes(`--resume ${session}`)).length
}

function parkedFile(): { items: { summary?: string; resume: { id: string } }[] } {
  const file = join(dataHome, 'ostia', 'parked-sessions.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { items: [] }
}

function fakeClaude(): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const script = [
    '#!/bin/sh',
    'cli() { ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" "$@" >/dev/null 2>&1; }',
    '[ "$1" = --plugin-dir ] && shift 4',
    'case "$1" in',
    '  --resume)',
    `    echo "fake-agent-resumed $*" | tee -a '${log}'`,
    '    cli resume-token claude "$2" ;;',
    '  busy)',
    '    cli resume-token claude busy-session',
    '    echo fake-agent-ready',
    '    cli state working',
    `    while [ ! -e '${release}' ]; do sleep 0.2; done`,
    `    cli state done "${CLOSING}" ;;`,
    '  *)',
    '    cli resume-token claude "$1"',
    '    echo fake-agent-ready',
    `    cli state done "${CLOSING}" ;;`,
    'esac',
    'exec cat',
    '',
  ].join('\n')
  writeFileSync(join(bin, 'claude'), script)
  chmodSync(join(bin, 'claude'), 0o755)
  return bin
}

function seedWorkspaces(): void {
  const home = testHome(dataHome)
  const mk = (id: string, name: string, dir: string): Place => {
    const folder = join(home, 'work', dir)
    mkdirSync(folder, { recursive: true })
    return { id, name, folder }
  }
  places = {
    one: mk('ws1', 'alpha', 'alpha'),
    two: mk('ws2', 'beta', 'beta'),
    three: mk('ws3', 'gamma', 'gamma'),
  }
  const config = join(dataHome, 'claude-config')
  mkdirSync(config, { recursive: true })
  const trusted = Object.fromEntries(
    [places.one, places.two].map((p) => [p.folder, { hasTrustDialogAccepted: true }]),
  )
  writeFileSync(
    join(config, '.claude.json'),
    JSON.stringify({ userID: 'e2e', projects: trusted }),
    {
      mode: 0o600,
    },
  )
  mkdirSync(join(dataHome, 'ostia'), { recursive: true })
  writeFileSync(
    join(dataHome, 'ostia', 'workspaces.json'),
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      activeWorkspaceId: places.one.id,
      groups: [],
      workspaces: Object.values(places).map((p) => ({
        id: p.id,
        name: p.name,
        kind: 'terminal',
        workDir: p.folder,
        root: { type: 'pane', id: `${p.id}-pane`, title: 'zsh', kind: 'terminal', cwd: p.folder },
        activePaneId: `${p.id}-pane`,
      })),
    }),
  )
}

async function selectWorkspace(place: Place): Promise<void> {
  const index = Object.values(places).indexOf(place) + 1
  await win.keyboard.press(`${WORKSPACE_KEY}+${index}`)
  await expect(
    win.locator(`.workzone-workspace:not([data-hidden]) .pane[data-pane-id="${place.id}-pane"]`),
  ).toBeVisible()
}

async function runAgent(argument: string): Promise<void> {
  await shownTerminal(win).click()
  await win.keyboard.type(`claude ${argument}`)
  await win.keyboard.press('Enter')
  await expect(win.locator(SHOWN_ROWS).last()).toContainText('fake-agent-ready', {
    timeout: 20_000,
  })
}

async function paletteRun(title: string): Promise<void> {
  await win.keyboard.press(chords.palette)
  await win.locator('[data-slot="command-input"]').fill(title)
  await waitForPaletteSelection(win, title)
  await win.keyboard.press('Enter')
}

function panelOf(place: Place, script: string): Promise<string> {
  return app.evaluate(
    async ({ webContents }, { workspaceId, code }) => {
      const guest = webContents
        .getAllWebContents()
        .find(
          (wc) =>
            wc.getType() === 'webview' &&
            wc.getURL().startsWith('http://127.0.0.1') &&
            wc.getURL().includes(`workspaceId=${workspaceId}`),
        )
      return guest ? String(await guest.executeJavaScript(code)) : ''
    },
    { workspaceId: place.id, code: script },
  )
}

async function openParkedTab(place: Place): Promise<void> {
  await paletteRun('Activity: Open')
  await win
    .locator('#right-panel')
    .getByRole('tab', { name: /Parked/ })
    .click()
  await expect
    .poll(() => panelOf(place, `document.querySelectorAll('[data-parked]').length`), {
      timeout: 20_000,
    })
    .not.toBe('')
}

const parkedSummaries = (place: Place): Promise<string> =>
  panelOf(
    place,
    `[...document.querySelectorAll('[data-parked] .note-text')].map((el) => el.innerText).join('|')`,
  )

const clickResume = (place: Place): Promise<string> =>
  panelOf(
    place,
    `[...document.querySelectorAll('[data-parked] button')].find((b) => b.textContent === 'Resume').click(); 'ok'`,
  )

function tabCount(): Promise<number> {
  return win.locator('.workzone-workspace:not([data-hidden]) .pane-tab').count()
}

async function parkFromMenu(): Promise<void> {
  await win.getByRole('button', { name: 'Agent actions' }).click()
  await win.getByRole('menuitem', { name: 'Park' }).click()
}

test.beforeAll(async () => {
  dataHome = freshDataHome()
  log = join(dataHome, 'resumed.log')
  release = join(dataHome, 'release')
  seedSettings(dataHome, CANVAS_RENDERER_SETTINGS)
  seedWorkspaces()
  const launch = isolatedLaunch(dataHome)
  app = await launchShared({
    ...launch,
    env: {
      ...launch.env,
      PATH: `${fakeClaude()}:${launch.env.PATH}`,
      CLAUDE_CONFIG_DIR: join(dataHome, 'claude-config'),
    },
  })
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator('.ghostty-host').first()).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  await app.close()
})

test('parking an idle agent closes its tab and lists it with its closing line; Resume opens a new tab that resumes the same session once', async () => {
  const place = places.one
  await selectWorkspace(place)
  await runAgent('session-a')
  await win.getByRole('button', { name: 'New terminal tab' }).click()
  await expect.poll(tabCount).toBe(2)
  await win.locator('.workzone-workspace:not([data-hidden]) .pane-tab').first().click()
  await expect(win.locator(SHOWN_ROWS).last()).toContainText('fake-agent-ready')

  await parkFromMenu()
  await expect(win.locator('[data-park-status="parked"]')).toContainText('Parked')
  await expect.poll(tabCount).toBe(1)
  await expect.poll(() => parkedFile().items.map((i) => i.resume.id)).toEqual(['session-a'])
  expect(parkedFile().items[0]?.summary).toBe(CLOSING)

  await openParkedTab(place)
  await expect.poll(() => parkedSummaries(place), { timeout: 20_000 }).toBe(CLOSING)

  await clickResume(place)
  await expect.poll(tabCount).toBe(2)
  await expect(win.locator(SHOWN_ROWS).last()).toContainText(
    /fake-agent-resumed --resume session-a/,
    { timeout: 20_000 },
  )
  await expect.poll(() => parkedFile().items.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => parkedSummaries(place), { timeout: 20_000 }).toBe('')
  await expectHeld(async () => resumes('session-a'), 1)
})

test('a busy agent and a locked tab are refused and stay; the only pane parks and Resume opens its first pane again', async () => {
  const place = places.two
  await selectWorkspace(place)
  await runAgent('busy')
  await paletteRun('Park Tab')
  await expect(win.locator('[data-park-status="refused"]')).toContainText('the agent is working')
  expect(await tabCount()).toBe(1)
  expect(parkedFile().items).toHaveLength(0)

  writeFileSync(release, '')
  await expect
    .poll(() => win.getByRole('button', { name: 'Agent actions' }).count(), { timeout: 20_000 })
    .toBe(1)
  await win.locator('.workzone-workspace:not([data-hidden]) .pane-tab').first().click({
    button: 'right',
  })
  await win.getByRole('menuitem', { name: 'Lock' }).click()
  await paletteRun('Park Tab')
  await expect(win.locator('[data-park-status="refused"]')).toContainText('the tab is locked')
  expect(parkedFile().items).toHaveLength(0)
  await win.locator('.workzone-workspace:not([data-hidden]) .pane-tab').first().click({
    button: 'right',
  })
  await win.getByRole('menuitem', { name: 'Unlock' }).click()

  await expect
    .poll(() => win.getByRole('button', { name: 'Agent actions' }).isEnabled(), { timeout: 20_000 })
    .toBe(true)
  await parkFromMenu()
  await expect(win.locator('.workspace-empty:visible')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => parkedFile().items.length).toBe(1)

  await openParkedTab(place)
  await clickResume(place)
  await expect(win.locator(SHOWN_ROWS).last()).toContainText(
    /fake-agent-resumed --resume busy-session/,
    { timeout: 20_000 },
  )
  await expect.poll(() => parkedFile().items.length, { timeout: 20_000 }).toBe(0)
  await expectHeld(async () => resumes('busy-session'), 1)
})

test('a folder Claude does not trust holds the resume: nothing is typed and the record stays', async () => {
  const place = places.three
  await selectWorkspace(place)
  await runAgent('session-c')
  await parkFromMenu()
  await expect.poll(() => parkedFile().items.length).toBe(1)

  await openParkedTab(place)
  await clickResume(place)
  const note = win.getByRole('region', { name: 'Claude folder trust' })
  await expect(note).toContainText(place.folder, { timeout: 20_000 })
  await expectHeld(async () => resumes('session-c'), 0)
  await win.keyboard.press(chords.closePane)
  await expect(note).toHaveCount(0, { timeout: 15_000 })
  await expectHeld(async () => resumes('session-c'), 0)
  expect(parkedFile().items.map((i) => i.resume.id)).toEqual(['session-c'])
})
