import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { GHOSTTY } from './ghostty'
import {
  emptyWorkspace,
  openWorkspace,
  quitApp,
  typeLine,
  waitForPaletteSelection,
} from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

const LINES = 20_000
const ENGINES = [
  { name: 'xterm', settings: DOM_RENDERER_SETTINGS, screen: '.xterm-screen' },
  { name: 'ghostty', settings: GHOSTTY, screen: '.ghostty-screen' },
]

function historyRoot(dataHome: string): string {
  return join(dataHome, 'ostia', 'scrollback')
}

function paneFolders(dataHome: string): string[] {
  const root = historyRoot(dataHome)
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((run) =>
    readdirSync(join(root, run)).map((pane) => join(root, run, pane)),
  )
}

function historyFiles(dataHome: string): string[] {
  return paneFolders(dataHome).flatMap((pane) => readdirSync(pane).map((file) => join(pane, file)))
}

async function runCommand(win: Page, title: string): Promise<void> {
  await win.keyboard.press(chords.palette)
  await win.locator('[data-slot="command-input"]').fill(title)
  await waitForPaletteSelection(win, title)
  await win.keyboard.press('Enter')
}

async function flood(win: Page, screen: string): Promise<void> {
  await win.locator(screen).first().click()
  await typeLine(win, `seq -f 'hist %g' ${LINES}; printf '\\033]0;HISTDONE\\007'`)
  await expect(win.locator('.pane-tab:visible .title').first()).toHaveText('HISTDONE', {
    timeout: 60_000,
  })
}

const historyScreen = (win: Page) => win.locator('.history-screen .xterm-rows')

async function launch(settings: Record<string, unknown> & { terminal?: object }): Promise<{
  app: ElectronApplication
  win: Page
  dataHome: string
}> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...settings,
    terminal: { ...settings.terminal, scrollbackLines: 1000 },
  })
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await openWorkspace(win)
  return { app, win, dataHome }
}

for (const engine of ENGINES) {
  test(`${engine.name}: output past the live terminal is kept on disk and read back`, async () => {
    test.setTimeout(180_000)
    const { app, win, dataHome } = await launch(engine.settings)
    try {
      await flood(win, engine.screen)
      await expect.poll(() => historyFiles(dataHome).length, { timeout: 15_000 }).toBeGreaterThan(0)
      for (const file of historyFiles(dataHome)) {
        expect(statSync(file).mode & 0o777).toBe(0o600)
      }

      await runCommand(win, 'Show Earlier Output')
      await expect(win.locator('.history-view')).toBeVisible()
      await win.getByRole('button', { name: 'Oldest' }).click()
      await expect(historyScreen(win)).toContainText(/hist 1(?!\d)/)
      await win.keyboard.press('Escape')
      await expect(win.locator('.history-view')).toHaveCount(0)

      await win.locator(engine.screen).first().click()
      await win.keyboard.press(chords.find)
      await win.getByRole('textbox', { name: 'Find in terminal' }).fill('hist 15')
      await win.getByRole('button', { name: /earlier$/ }).click()
      await expect(win.locator('.history-view')).toBeVisible()
      await expect(historyScreen(win)).toContainText('hist 15999')
      await win.getByRole('button', { name: 'Back to live' }).click()

      await win.locator(engine.screen).first().click()
      await win.keyboard.press(chords.blockPrev)
      await expect(win.locator('.history-view')).toBeVisible()
      await expect(historyScreen(win)).toContainText(/hist 1(?!\d)/)
      await win.getByRole('button', { name: 'Back to live' }).click()
      await runCommand(win, 'Copy Block Output')
      await expect
        .poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).split('\n'))
        .toEqual(Array.from({ length: LINES }, (_, i) => `hist ${i + 1}`))
    } finally {
      await app.close()
    }
  })
}

test('clear, closing the pane and quitting leave no history behind', async () => {
  test.setTimeout(180_000)
  const { app, win, dataHome } = await launch(DOM_RENDERER_SETTINGS)
  let closed = false
  try {
    await flood(win, '.xterm-screen')
    await expect.poll(() => historyFiles(dataHome).length, { timeout: 15_000 }).toBeGreaterThan(0)
    await typeLine(win, 'clear')
    await expect.poll(() => historyFiles(dataHome).length, { timeout: 15_000 }).toBe(0)

    await flood(win, '.xterm-screen')
    await expect.poll(() => historyFiles(dataHome).length, { timeout: 15_000 }).toBeGreaterThan(0)
    await runCommand(win, 'Scroll to Top')
    await win.locator('.xterm-screen').first().hover()
    await win.mouse.wheel(0, -100)
    await expect(win.locator('.history-edge')).toBeVisible()
    await win.locator('.history-edge').getByRole('button', { name: 'Show' }).click()
    await expect(win.locator('.history-view')).toBeVisible()
    await win.getByRole('button', { name: 'Back to live' }).click()

    await win.keyboard.press(chords.splitRight)
    await expect(win.locator('.xterm-screen')).toHaveCount(2, { timeout: 15_000 })
    await flood(win, '.pane.active .xterm-screen')
    await expect.poll(() => paneFolders(dataHome).length, { timeout: 15_000 }).toBe(2)
    await win.keyboard.press(chords.closePane)
    await expect.poll(() => paneFolders(dataHome).length, { timeout: 15_000 }).toBe(1)
    await app.close()
    closed = true
    expect(readdirSync(historyRoot(dataHome))).toEqual([])
  } finally {
    if (!closed) await app.close()
  }
})

test('a scratch workspace takes its history with it when it closes', async () => {
  test.setTimeout(120_000)
  const { app, win, dataHome } = await launch(DOM_RENDERER_SETTINGS)
  try {
    await win
      .locator('.topbar')
      .getByRole('button', { name: 'More ways to start a workspace' })
      .click()
    await win.getByRole('menuitem', { name: 'New scratch workspace' }).click()
    const row = win.locator('.rail-tab', { has: win.getByText('Scratch', { exact: true }) })
    await expect(row).toBeVisible()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await flood(win, '.xterm-screen:visible')
    await expect.poll(() => paneFolders(dataHome).length, { timeout: 15_000 }).toBe(1)
    await typeLine(win, 'echo kept > a.txt')
    await row.hover()
    await row.getByRole('button', { name: 'Close', exact: true }).click()
    await win.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(row).toHaveCount(0)
    await expect.poll(() => paneFolders(dataHome).length, { timeout: 15_000 }).toBe(0)
  } finally {
    await app.close()
  }
})

test('a restart restores the screen and starts a fresh history from it', async () => {
  test.setTimeout(180_000)
  const first = await launch(DOM_RENDERER_SETTINGS)
  try {
    await flood(first.win, '.xterm-screen')
    await expect.poll(() => paneFolders(first.dataHome).length, { timeout: 15_000 }).toBe(1)
  } finally {
    await quitApp(first.app)
  }
  expect(readdirSync(historyRoot(first.dataHome))).toEqual([])

  const app = await electron.launch(isolatedLaunch(first.dataHome))
  try {
    const win = await app.firstWindow()
    await expect(win.locator('.xterm-rows').first()).toContainText('hist 20000', {
      timeout: 30_000,
    })
    await win.locator('.xterm-screen').first().click()
    await typeLine(win, `seq -f 'more %g' 3000`)
    await expect(win.locator('.xterm-rows').first()).toContainText('more 3000', {
      timeout: 30_000,
    })
    await runCommand(win, 'Show Earlier Output')
    await win.getByRole('button', { name: 'Oldest' }).click()
    await expect(historyScreen(win)).toContainText('hist 19')
  } finally {
    await app.close()
  }
})
