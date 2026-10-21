import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import {
  closeAllWorkspaces,
  emptyState,
  emptyWorkspace,
  expectHeld,
  newTerminalWorkspace,
  openWorkspace,
  PROMPT,
  waitForTerminalFocus,
} from './helpers'
import { type ElectronApplication, expect, launchShared, type Page, test } from './test'

let app: ElectronApplication | undefined
let win: Page
let home: string
const bootErrors: string[] = []

test.beforeAll(async () => {
  const launch = isolatedLaunch()
  home = launch.home
  app = await launchShared(launch)
  win = await app.firstWindow()
  win.on('pageerror', (err) => bootErrors.push(err.message))
  win.on('console', (msg) => {
    if (msg.type() === 'error') bootErrors.push(msg.text())
  })
  await win.waitForLoadState('domcontentloaded')
})

test.afterEach(async () => {
  await closeAllWorkspaces(win)
})

test.afterAll(async () => {
  await app?.close()
})

test('boots with no workspace, and the new-workspace chord opens an empty one that offers a terminal', {
  tag: '@core',
}, async () => {
  await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
  await expectHeld(
    async () => ({
      terminals: await win.locator('.xterm').count(),
      workspaces: await win.locator('.rail-tab').count(),
    }),
    { terminals: 0, workspaces: 0 },
    1_000,
  )

  await win.keyboard.press(chords.newWorkspace)

  await expect(win.locator('.rail-tab')).toHaveCount(1)
  await expect(win.locator('.xterm')).toHaveCount(0)
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
  await expect(win.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })
  await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
  await expect(win.locator('.rail-tab')).toHaveCount(1)
  await expect(emptyState(win)).toHaveCount(0)
  expect(bootErrors).toEqual([])
})

test('after the only workspace closes, New workspace opens a terminal at ~', {
  tag: '@core',
}, async () => {
  test.setTimeout(60_000)
  await openWorkspace(win)
  const tab = win.locator('.rail-tab')
  await expect(tab).toHaveCount(1)

  await tab.hover()
  await tab.getByRole('button', { name: 'Close' }).click()

  await expect(tab).toHaveCount(0)

  await openWorkspace(win)
  await expect(tab).toHaveCount(1)
  await win.locator('.xterm').first().click()
  await waitForTerminalFocus(win)
  await win.keyboard.type('echo "ostia_cwd:$PWD:"')
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm-rows').first()).toContainText(`ostia_cwd:${home}:`, {
    timeout: 15_000,
  })
})

test('Ctrl+1 jumps to the first workspace from a focused terminal', async () => {
  await openWorkspace(win)
  await newTerminalWorkspace(win)
  await expect(win.locator('.rail-row')).toHaveCount(2)
  await win.locator('.rail-tab-main').nth(1).dblclick()
  const name = win.getByRole('textbox', { name: 'Workspace name' })
  await name.fill('second')
  await name.press('Enter')

  await win.locator('.pane-slot:not([data-hidden]) .xterm').last().click()
  await waitForTerminalFocus(win)
  await win.keyboard.press(chords.firstWorkspace)
  await expect(win.locator('.rail-tab.active .tab-title')).toHaveText('home')
})
