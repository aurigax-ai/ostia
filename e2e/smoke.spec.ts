import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import {
  closeAllWorkspaces,
  emptyState,
  openWorkspace,
  PROMPT,
  runInTerminal,
  waitForTerminalFocus,
} from './helpers'
import { type ElectronApplication, expect, launchShared, type Page, test } from './test'

let app: ElectronApplication | undefined
let win: Page

test.beforeAll(async () => {
  const launch = isolatedLaunch()
  app = await launchShared(launch)
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
})

test.afterEach(async () => {
  await closeAllWorkspaces(win)
})

test.afterAll(async () => {
  await app?.close()
})

test('boots and renders the main window', { tag: '@core' }, async () => {
  expect(await win.title()).toBeTruthy()
  await expect(win.locator('.deck-rail')).toBeVisible({ timeout: 15_000 })
  await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
  await openWorkspace(win)
})

test('terminal spawns and runs a command', { tag: '@core' }, async () => {
  await openWorkspace(win)

  const term = win.locator('.ghostty-host').first()
  await term.click()
  await waitForTerminalFocus(win)

  await win.keyboard.type('echo ostia_e2e_$((21+21))')
  await win.keyboard.press('Enter')

  await expect(win.locator('.terminal-text').first()).toContainText('ostia_e2e_42', {
    timeout: 15_000,
  })
})

test('the default close-pane chord closes only the focused pane and leaves the other shell running', {
  tag: '@core',
}, async () => {
  await openWorkspace(win)
  await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
  await expect(win.locator('.ghostty-host')).toHaveCount(2, { timeout: 15_000 })
  await expect(win.locator('.terminal-text').nth(1)).toContainText(PROMPT, { timeout: 15_000 })

  await runInTerminal(win, 'echo keep-$$', win.locator('.ghostty-host').nth(1))
  const keptRows = win.locator('.terminal-text').nth(1)
  await expect(keptRows).toContainText(/keep-\d+/, { timeout: 15_000 })
  const keptPid = (await keptRows.innerText()).match(/keep-(\d+)/)?.[1] ?? ''
  expect(keptPid).not.toBe('')

  await win.locator('.ghostty-host').nth(0).click()
  await waitForTerminalFocus(win)
  await win.keyboard.press(chords.closePane)

  await expect(win.locator('.ghostty-host')).toHaveCount(1, { timeout: 15_000 })
  await expect(win.locator('.pane')).toHaveCount(1)

  await runInTerminal(win, 'echo still-$$')
  const rows = win.locator('.terminal-text').first()
  await expect(rows).toContainText(`still-${keptPid}`, { timeout: 15_000 })
  expect(win.isClosed()).toBe(false)
})

test('opening a file shows the Monaco editor', async () => {
  await openWorkspace(win)
  await expect(win.locator('.monaco-editor')).toHaveCount(0)

  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()

  const fileRow = win.locator('.file-row:has(.file-twisty-spacer)').first()
  await expect(fileRow).toBeVisible({ timeout: 10_000 })
  const fileName = (await fileRow.locator('.file-name').innerText()).trim()
  expect(fileName.length).toBeGreaterThan(0)
  await fileRow.click()

  await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.pane-header .title').filter({ hasText: fileName })).toBeVisible({
    timeout: 15_000,
  })
})
