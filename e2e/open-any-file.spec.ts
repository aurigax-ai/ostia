import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, PROMPT, shownTerminal, terminalTab } from './helpers'
import { centerOf, dragFiles, dropFiles } from './osDrag'
import { _electron as electron, expect, type Page, test } from './test'
import { viewerGuestRun } from './viewerGuest'

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function outsideFiles(dataHome: string): { log: string; image: string; dir: string } {
  const dir = join(dataHome, 'outside')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'app.log')
  const image = join(dir, 'shot.png')
  writeFileSync(log, 'first line\nsecond line outside home\n')
  writeFileSync(image, PIXEL_PNG)
  return { log, image, dir }
}

function tab(win: Page, title: string) {
  return win.locator('.pane-tab').filter({ hasText: title })
}

async function dragOverTarget(win: Page): Promise<string> {
  return win.evaluate(() => {
    const seen = window as unknown as { lastDragOverTarget?: string; watchesDragOver?: boolean }
    if (!seen.watchesDragOver) {
      seen.watchesDragOver = true
      document.addEventListener(
        'dragover',
        (e) => {
          seen.lastDragOverTarget =
            e.target instanceof Element && e.target.closest('.pane-header') ? 'pane-header' : ''
        },
        true,
      )
    }
    return seen.lastDragOverTarget ?? ''
  })
}

async function dropFilesOverBrowserHeader(
  win: Page,
  paths: string[],
  enterAt: { x: number; y: number },
  header: { x: number; y: number },
): Promise<void> {
  await dragOverTarget(win)
  const drag = await dragFiles(win, paths)
  await drag.send('dragEnter', enterAt)
  await drag.send('dragOver', enterAt)
  await expect(win.locator(':root')).toHaveAttribute('data-file-drag', '')
  await expect
    .poll(async () => {
      await drag.send('dragOver', header)
      return dragOverTarget(win)
    })
    .toBe('pane-header')
  await drag.send('drop', header)
  await drag.done()
}

test('ostia <file> shows a text file and an image from outside the home folder, and a restart keeps them', async () => {
  const dataHome = freshDataHome()
  const { log, image } = outsideFiles(dataHome)
  const launch = isolatedLaunch(dataHome)
  expect(log.startsWith(`${launch.home}/`)).toBe(false)

  let app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.ghostty-host').first().click()
    const neighbour = join(dataHome, 'outside', 'neighbour.txt')
    writeFileSync(neighbour, 'never opened\n')
    expect(await win.evaluate((path) => window.ostia.fs.read(path), log)).toEqual({
      ok: false,
      error: 'denied',
    })

    await win.keyboard.type(`ostia ${log}:2 ${image}`)
    await win.keyboard.press('Enter')

    await expect(tab(win, 'app.log')).toBeVisible({ timeout: 15_000 })
    await expect(tab(win, 'shot.png')).toBeVisible()
    expect(await win.evaluate((path) => window.ostia.fs.read(path), neighbour)).toEqual({
      ok: false,
      error: 'denied',
    })
    await expect
      .poll(
        () =>
          viewerGuestRun(
            app,
            { viewType: 'images.image', name: 'shot.png' },
            'document.querySelector(".canvas img")?.naturalWidth ?? 0',
          ),
        { timeout: 20_000 },
      )
      .toBe(1)

    await tab(win, 'app.log').getByRole('tab').click()
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText(
      'second line outside home',
      { timeout: 15_000 },
    )
    await terminalTab(win).click()
    await expect(shownTerminal(win).locator('.terminal-text')).toContainText(PROMPT)
    await expect(shownTerminal(win).locator('.terminal-text')).not.toContainText('ostia:')
  } finally {
    await app.close()
  }

  app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(tab(win, 'app.log')).toBeVisible({ timeout: 15_000 })
    await tab(win, 'app.log').getByRole('tab').click()
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText(
      'second line outside home',
      { timeout: 15_000 },
    )
  } finally {
    await app.close()
  }
})

test('a file dropped on the window or a browser header opens in the viewer; dropped on a terminal it pastes its path', async () => {
  const dataHome = freshDataHome()
  const { log, dir } = outsideFiles(dataHome)
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const terminal = await centerOf(win.locator('.terminal-surface:visible'))
    await dropFiles(win, [log], terminal)
    await expect(win.locator('.terminal-text:visible')).toContainText(log, { timeout: 10_000 })
    await expect(tab(win, 'app.log')).toHaveCount(0)

    const notes = join(dir, 'notes.txt')
    writeFileSync(notes, 'dropped on the browser header\n')
    await win.getByRole('button', { name: 'New browser tab', exact: true }).first().click()
    await expect(win.locator('webview:visible')).toBeVisible({ timeout: 15_000 })
    const header = await centerOf(win.locator('.pane.active .pane-header'))
    await dropFilesOverBrowserHeader(win, [notes], await centerOf(win.locator('.topbar')), header)
    await expect(tab(win, 'notes.txt')).toBeVisible({ timeout: 10_000 })
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText(
      'dropped on the browser header',
      { timeout: 15_000 },
    )
  } finally {
    await app.close()
  }
})
