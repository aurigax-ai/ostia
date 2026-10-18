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

const historyScreen = (win: Page) => win.locator('.history-pane:not([style*="hidden"]) .xterm-rows')

const layer = (win: Page) => win.locator('.history-layer')

const layerTop = async (win: Page): Promise<number> =>
  Number(await layer(win).getAttribute('data-top'))

async function wheelIntoHistory(win: Page, screen: string): Promise<void> {
  await win.locator(screen).first().hover()
  await runCommand(win, 'Scroll to Bottom')
  for (let i = 0; i < 400 && !(await layer(win).isVisible()); i++) {
    await win.mouse.wheel(0, -1500)
    await win.waitForTimeout(40)
  }
  await expect(layer(win)).toBeVisible()
}

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

      await wheelIntoHistory(win, engine.screen)
      await expect(win.locator('.history-view, .history-bar, .history-edge')).toHaveCount(0)
      await expect(win.locator('.history-scrollbar')).toHaveCount(1)
      const entered = await layerTop(win)
      await win.mouse.wheel(0, -600)
      await expect.poll(() => layerTop(win)).toBeLessThan(entered)
      const deep = await layerTop(win)
      await win.mouse.wheel(0, 600)
      await expect.poll(() => layerTop(win)).toBeGreaterThan(deep)
      await runCommand(win, 'Scroll to Top')
      await expect.poll(() => layerTop(win)).toBeLessThan(40)
      if (engine.name === 'xterm') await expect(historyScreen(win)).toContainText(/hist 1(?!\d)/)
      await runCommand(win, 'Scroll to Bottom')
      await expect(layer(win)).toBeHidden()
      await wheelIntoHistory(win, engine.screen)
      for (let i = 0; i < 10; i++) await win.mouse.wheel(0, -600)
      const seen: number[] = []
      for (let i = 0; i < 300 && (await layer(win).isVisible()); i++) {
        await win.mouse.wheel(0, 120)
        await win.waitForTimeout(40)
        if (await layer(win).isVisible()) seen.push(await layerTop(win))
      }
      await expect(layer(win)).toBeHidden()
      expect(seen.length).toBeGreaterThan(3)
      expect(seen).toEqual([...seen].sort((x, y) => x - y))

      await wheelIntoHistory(win, engine.screen)
      await win.keyboard.type('x')
      await expect(layer(win)).toBeHidden()
      await win.keyboard.press('Backspace')

      await win.locator(engine.screen).first().click()
      await win.keyboard.press(chords.find)
      await win.getByRole('textbox', { name: 'Find in terminal' }).fill('hist 15')
      await win.getByRole('button', { name: /earlier$/ }).click()
      await expect(layer(win)).toBeVisible()
      if (engine.name === 'xterm') await expect(historyScreen(win)).toContainText('hist 15999')
      await runCommand(win, 'Scroll to Bottom')
      await expect(layer(win)).toBeHidden()

      await win.locator(engine.screen).first().click()
      await win.keyboard.press(chords.blockPrev)
      await expect(layer(win)).toBeVisible()
      if (engine.name === 'xterm') await expect(historyScreen(win)).toContainText(/hist 1(?!\d)/)
      await runCommand(win, 'Scroll to Bottom')
      await expect(layer(win)).toBeHidden()
      await runCommand(win, 'Copy Block Output')
      await expect
        .poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).split('\n'))
        .toEqual(Array.from({ length: LINES }, (_, i) => `hist ${i + 1}`))
    } finally {
      await app.close()
    }
  })
}

for (const engine of ENGINES) {
  test(`${engine.name}: a mouse selection in history is copied, keeps the layer and leaves the keyboard on the live pane`, async () => {
    test.setTimeout(180_000)
    const { app, win } = await launch(engine.settings)
    try {
      await flood(win, engine.screen)
      await wheelIntoHistory(win, engine.screen)
      await app.evaluate(({ clipboard }) => clipboard.writeText(''))
      const box = await layer(win).boundingBox()
      if (!box) throw new Error('history layer has no box')
      await win.mouse.move(box.x + 4, box.y + 40)
      await win.mouse.down()
      await win.mouse.move(box.x + 140, box.y + 90, { steps: 8 })
      await win.mouse.up()
      await win.keyboard.press(chords.copy)
      await expect
        .poll(async () => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toMatch(/hist \d+/)
      await expect(layer(win)).toBeVisible()
      const focusInLayer = await win.evaluate(
        () => document.querySelector('.history-layer')?.contains(document.activeElement) ?? false,
      )
      expect(focusInLayer).toBe(false)
      await win.keyboard.type('x')
      await expect(layer(win)).toBeHidden()
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
    await wheelIntoHistory(win, '.xterm-screen')
    await runCommand(win, 'Scroll to Bottom')
    await expect(layer(win)).toBeHidden()

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
    await runCommand(win, 'Scroll to Top')
    await expect(layer(win)).toBeVisible()
    await expect(historyScreen(win)).toContainText('hist 19')
  } finally {
    await app.close()
  }
})
