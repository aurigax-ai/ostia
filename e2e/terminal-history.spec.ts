import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { GHOSTTY } from './ghostty'
import {
  emptyWorkspace,
  openWorkspace,
  quitApp,
  scratchRow,
  typeLine,
  waitForPaletteSelection,
} from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

const LINES = 3000
const SEAM_WHEEL_PX = 6000
const ROOM_ABOVE_SEAM = 600
const WHEEL_BURST = 40
const ENGINES = {
  xterm: { settings: DOM_RENDERER_SETTINGS, screen: '.xterm-screen' },
  ghostty: { settings: GHOSTTY, screen: '.ghostty-screen' },
}

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
  await expect(win.locator('[data-slot="dialog-overlay"]')).toHaveCount(0)
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
  await expect
    .poll(
      async () => {
        for (let i = 0; i < WHEEL_BURST; i++) {
          await win.mouse.wheel(0, -1500)
          if (await layer(win).isVisible()) return true
        }
        return false
      },
      { timeout: 30_000, intervals: [50, 100, 250] },
    )
    .toBe(true)
}

async function wheelFromHistory(win: Page, delta: number): Promise<number | null> {
  const before = await layerTop(win)
  await win.mouse.wheel(0, delta)
  await expect
    .poll(async () => !(await layer(win).isVisible()) || (await layerTop(win)) !== before)
    .toBe(true)
  return (await layer(win).isVisible()) ? layerTop(win) : null
}

async function selectInHistory(app: ElectronApplication, win: Page): Promise<void> {
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

async function readBackHistory(
  app: ElectronApplication,
  win: Page,
  engine: keyof typeof ENGINES,
): Promise<void> {
  const { screen } = ENGINES[engine]
  const showsText = async (text: string | RegExp): Promise<void> => {
    if (engine === 'xterm') await expect(historyScreen(win)).toContainText(text)
  }
  await wheelIntoHistory(win, screen)
  await expect(win.locator('.history-view, .history-bar, .history-edge')).toHaveCount(0)
  await expect(win.locator('.history-scrollbar')).toHaveCount(1)
  const entered = await layerTop(win)
  if (entered > ROOM_ABOVE_SEAM) {
    expect(await wheelFromHistory(win, -600)).toBeLessThan(entered)
    const deep = await layerTop(win)
    expect(await wheelFromHistory(win, 600)).toBeGreaterThan(deep)
  }
  for (let i = 0; i < 60 && (await layer(win).isVisible()); i++)
    await wheelFromHistory(win, SEAM_WHEEL_PX)
  await expect(layer(win)).toBeHidden()

  await runCommand(win, 'Scroll to Top')
  await expect(layer(win)).toBeVisible()
  await expect.poll(() => layerTop(win)).toBeLessThan(40)
  await showsText(/hist 1(?!\d)/)
  await selectInHistory(app, win)
  await win.keyboard.type('x')
  await expect(layer(win)).toBeHidden()
  await win.keyboard.press('Backspace')

  await win.locator(screen).first().click()
  await win.keyboard.press(chords.find)
  await win.getByRole('textbox', { name: 'Find in terminal' }).fill('hist 15')
  await win.getByRole('button', { name: /earlier$/ }).click()
  await expect(layer(win)).toBeVisible()
  await showsText('hist 1599')
  await runCommand(win, 'Scroll to Bottom')
  await expect(layer(win)).toBeHidden()

  await win.locator(screen).first().click()
  await win.keyboard.press(chords.blockPrev)
  await expect(layer(win)).toBeVisible()
  await showsText(/hist 1(?!\d)/)
  await runCommand(win, 'Scroll to Bottom')
  await expect(layer(win)).toBeHidden()
  await runCommand(win, 'Copy Block Output')
  await expect
    .poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).split('\n'))
    .toEqual(Array.from({ length: LINES }, (_, i) => `hist ${i + 1}`))
}

for (const engine of ['xterm', 'ghostty'] as const) {
  test(`${engine}: output past the live terminal is kept on disk, read back, selected and searched`, async () => {
    test.setTimeout(120_000)
    const { app, win, dataHome } = await launch(ENGINES[engine].settings)
    try {
      await flood(win, ENGINES[engine].screen)
      await expect.poll(() => historyFiles(dataHome).length, { timeout: 15_000 }).toBeGreaterThan(0)
      await readBackHistory(app, win, engine)
    } finally {
      await app.close()
    }
  })
}

test('clear, closing a pane, closing a scratch workspace and quitting leave no history behind, and a restart restores the screen', async () => {
  test.setTimeout(180_000)
  const first = await launch(DOM_RENDERER_SETTINGS)
  const { win, dataHome } = first
  try {
    await flood(win, '.xterm-screen')
    await expect.poll(() => historyFiles(dataHome).length, { timeout: 15_000 }).toBeGreaterThan(0)
    await typeLine(win, 'clear')
    await expect.poll(() => historyFiles(dataHome).length, { timeout: 15_000 }).toBe(0)

    await flood(win, '.xterm-screen')
    await expect.poll(() => historyFiles(dataHome).length, { timeout: 15_000 }).toBeGreaterThan(0)
    await runCommand(win, 'Scroll to Top')
    await expect(layer(win)).toBeVisible()
    await runCommand(win, 'Scroll to Bottom')
    await expect(layer(win)).toBeHidden()

    await win.keyboard.press(chords.splitRight)
    await expect(win.locator('.xterm-screen')).toHaveCount(2, { timeout: 15_000 })
    await flood(win, '.pane.active .xterm-screen')
    await expect.poll(() => paneFolders(dataHome).length, { timeout: 15_000 }).toBe(2)
    await win.keyboard.press(chords.closePane)
    await expect.poll(() => paneFolders(dataHome).length, { timeout: 15_000 }).toBe(1)

    await win
      .locator('.topbar')
      .getByRole('button', { name: 'More ways to start a workspace' })
      .click()
    await win.getByRole('menuitem', { name: 'New scratch workspace' }).click()
    const row = scratchRow(win)
    await expect(row).toBeVisible()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await flood(win, '.xterm-screen:visible')
    await expect.poll(() => paneFolders(dataHome).length, { timeout: 15_000 }).toBe(2)
    await typeLine(win, 'echo kept > a.txt')
    await row.hover()
    await row.getByRole('button', { name: 'Close', exact: true }).click()
    await win.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(row).toHaveCount(0)
    await expect.poll(() => paneFolders(dataHome).length, { timeout: 15_000 }).toBe(1)
  } finally {
    await quitApp(first.app)
  }
  expect(readdirSync(historyRoot(dataHome))).toEqual([])

  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const restored = await app.firstWindow()
    await expect(restored.locator('.xterm-rows').first()).toContainText(`hist ${LINES}`, {
      timeout: 30_000,
    })
    await restored.locator('.xterm-screen').first().click()
    await typeLine(restored, `seq -f 'more %g' 3000`)
    await expect(restored.locator('.xterm-rows').first()).toContainText('more 3000', {
      timeout: 30_000,
    })
    await runCommand(restored, 'Scroll to Top')
    await expect(layer(restored)).toBeVisible()
    await expect(historyScreen(restored)).toContainText(/hist \d+/)
  } finally {
    await app.close()
  }
})
