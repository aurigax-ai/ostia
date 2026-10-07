import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { emptyState, openWorkspace } from './helpers'

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

type DragStep = 'dragEnter' | 'dragOver' | 'drop'

async function dragFiles(win: Page, paths: string[]) {
  const cdp = await win.context().newCDPSession(win)
  const data = { items: [], files: paths, dragOperationsMask: 1 }
  return {
    send: (type: DragStep, at: { x: number; y: number }) =>
      cdp.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data }),
    done: () => cdp.detach(),
  }
}

async function dropFiles(win: Page, paths: string[], x: number, y: number): Promise<void> {
  const drag = await dragFiles(win, paths)
  for (const step of ['dragEnter', 'dragOver', 'drop'] as const) await drag.send(step, { x, y })
  await drag.done()
}

async function dragOverTarget(win: Page): Promise<string> {
  return win.evaluate(() => {
    const seen = window as unknown as { lastDragOverTarget?: string; watchesDragOver?: boolean }
    if (!seen.watchesDragOver) {
      seen.watchesDragOver = true
      document.addEventListener(
        'dragover',
        (e) => {
          seen.lastDragOverTarget = e.target instanceof Element ? e.target.className : ''
        },
        true,
      )
    }
    return seen.lastDragOverTarget ?? ''
  })
}

async function dropFilesOverGuestPage(
  win: Page,
  paths: string[],
  enterAt: { x: number; y: number },
  page: { x: number; y: number },
): Promise<void> {
  await dragOverTarget(win)
  const drag = await dragFiles(win, paths)
  await drag.send('dragEnter', enterAt)
  await drag.send('dragOver', enterAt)
  await expect(win.locator(':root')).toHaveAttribute('data-file-drag', '')
  await expect
    .poll(async () => {
      await drag.send('dragOver', page)
      return dragOverTarget(win)
    })
    .toBe('pane-file-drop')
  await drag.send('drop', page)
  await drag.done()
}

async function centerOf(win: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await win.locator(selector).first().boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
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
    await win.locator('.xterm').first().click()
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
    await expect(win.locator('.viewer-meta:visible')).toHaveText('1 × 1', { timeout: 15_000 })

    await tab(win, 'app.log').getByRole('tab').click()
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText(
      'second line outside home',
      { timeout: 15_000 },
    )
    await expect(win.locator('.xterm-rows').first()).not.toContainText('ostia:')
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

test('ostia <file> names what it cannot open and opens nothing for it', async () => {
  const dataHome = freshDataHome()
  const { dir } = outsideFiles(dataHome)
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.xterm').first().click()

    await win.keyboard.type(`ostia ${dir} ${join(dir, 'nope.txt')}`)
    await win.keyboard.press('Enter')

    await expect(win.locator('.xterm-rows')).toContainText(`${dir}: is a directory`, {
      timeout: 15_000,
    })
    await expect(win.locator('.xterm-rows')).toContainText('nope.txt: no such file')
    await expect(win.locator('.pane-tab')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('a file dropped on the window opens in the viewer; dropped on a terminal it pastes its path', async () => {
  const dataHome = freshDataHome()
  const { log, image, dir } = outsideFiles(dataHome)
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })

    const empty = await centerOf(win, '.workzone-empty')
    await dropFiles(win, [image], empty.x, empty.y)
    await expect(tab(win, 'shot.png')).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.viewer-meta:visible')).toHaveText('1 × 1', { timeout: 15_000 })

    const body = await centerOf(win, '.viewer-stage')
    await dropFiles(win, [log], body.x, body.y)
    await expect(tab(win, 'app.log')).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText(
      'second line outside home',
      { timeout: 15_000 },
    )

    await win.getByRole('button', { name: 'New terminal tab', exact: true }).first().click()
    await expect(win.locator('.xterm-rows:visible')).toContainText(/[❯$%#]/, { timeout: 15_000 })
    const terminal = await centerOf(win, '.terminal-surface:visible')
    await dropFiles(win, [log], terminal.x, terminal.y)
    await expect(win.locator('.xterm-rows:visible')).toContainText(log, { timeout: 10_000 })
    await expect(win.locator('.pane-tab')).toHaveCount(3)

    const header = await centerOf(win, '.pane-tabs')
    await dropFiles(win, [log], header.x, header.y)
    await expect(tab(win, 'app.log')).toHaveClass(/selected/, { timeout: 10_000 })
    await expect(win.locator('.pane-tab')).toHaveCount(3)

    const notes = join(dir, 'notes.txt')
    writeFileSync(notes, 'dropped on a web page\n')
    await win.getByRole('button', { name: 'New browser tab', exact: true }).first().click()
    await expect(win.locator('webview:visible')).toBeVisible({ timeout: 15_000 })
    const page = await centerOf(win, 'webview:visible')
    await dropFilesOverGuestPage(win, [notes], await centerOf(win, '.topbar'), page)
    await expect(tab(win, 'notes.txt')).toBeVisible({ timeout: 10_000 })
    await expect(win.locator('.monaco-editor:visible .view-lines')).toContainText(
      'dropped on a web page',
      { timeout: 15_000 },
    )
  } finally {
    await app.close()
  }
})
