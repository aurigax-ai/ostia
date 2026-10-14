import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

interface Launched {
  app: ElectronApplication
  win: Page
}

async function launchWithNotes(): Promise<Launched> {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'notes'), { recursive: true })
  writeFileSync(
    join(home, 'notes', 'todo.md'),
    'first line\nsecond line\nfind the needle here\nlast line\n',
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

async function focusTerminal(win: Page): Promise<void> {
  await win.locator('.xterm').first().click()
  await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
}

const cursorLine = (win: Page) =>
  win.evaluate(() => {
    const cursor = document.querySelector('.monaco-editor .cursors-layer .cursor') as HTMLElement
    const lines = [...document.querySelectorAll('.monaco-editor .view-lines .view-line')]
    const top = cursor?.getBoundingClientRect().top
    const line = lines.find((el) => Math.abs(el.getBoundingClientRect().top - top) < 2)
    return line?.textContent?.replaceAll('\u00a0', ' ')
  })

test('F1 opens the palette from a terminal, an editor and a browser pane, and a terminal program never gets the key', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<title>F1 page</title><input id="field" autofocus>')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const { app, win } = await launchWithNotes()
  try {
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    const rows = win.locator('.xterm-rows').first()
    await focusTerminal(win)
    await win.keyboard.type('cat -v\n')

    await win.keyboard.press('F1')
    await expect(palette.getByRole('combobox')).toBeFocused()
    await expect(palette.getByRole('combobox')).toHaveValue('>')
    await win.keyboard.press('F1')
    await expect(palette).toBeHidden()
    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
    await win.keyboard.type('after-f1\n')
    await expect
      .poll(async () => (await rows.innerText()).split('\n').filter((l) => l.trim() === 'after-f1'))
      .toHaveLength(2)
    await expect(rows).not.toContainText('^[')

    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await win.locator('.file-row').filter({ hasText: 'notes' }).click()
    await win.locator('.file-row').filter({ hasText: 'todo.md' }).click()
    const lines = win.locator('.monaco-editor .view-lines').first()
    await expect(lines).toContainText('find the needle here', { timeout: 15_000 })
    await lines.click()
    await win.keyboard.press('F1')
    await expect(palette.getByRole('combobox')).toBeFocused()
    await expect(win.locator('.quick-input-widget:visible')).toHaveCount(0)
    await win.keyboard.press('F1')
    await expect(palette).toBeHidden()

    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill(url)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /F1 page/ })).toBeVisible({ timeout: 15_000 })
    await app.evaluate(({ webContents }, url) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
      for (const type of ['keyDown', 'keyUp'] as const) {
        guest?.sendInputEvent({ type, keyCode: 'F1' })
      }
    }, url)
    await expect(palette.getByRole('combobox')).toBeFocused()
  } finally {
    await app.close()
    server.close()
  }
})

test('the palette chord closes the palette from every mode and gives the keyboard back to the terminal', async () => {
  const { app, win } = await launchWithNotes()
  try {
    const rows = win.locator('.xterm-rows').first()
    const dialog = win.getByRole('dialog')
    const input = dialog.getByRole('combobox')
    await focusTerminal(win)
    await win.keyboard.type('cat -v\n')

    const closesBack = async (mode: string): Promise<void> => {
      await win.keyboard.press(chords.palette)
      await expect(dialog, mode).toBeHidden()
      await expect(win.locator('.xterm-helper-textarea').first(), mode).toBeFocused()
    }

    for (const prefix of ['>', '', '@', '#', '/', '%', '?']) {
      await win.keyboard.press(chords.palette)
      await expect(input).toBeFocused()
      await input.fill(prefix)
      await closesBack(`prefix "${prefix}"`)
    }

    await win.keyboard.press('Shift')
    await win.keyboard.press('Shift')
    await expect(win.getByRole('dialog', { name: 'Search everywhere' })).toBeVisible()
    await expect(input).toBeFocused()
    await win.keyboard.type('needle')
    await closesBack('Search Everywhere')

    await win.keyboard.press(chords.palette)
    await expect(input).toBeFocused()
    await win.keyboard.type('Move Tab to Workspace')
    await dialog.getByRole('option', { name: /^Move Tab to Workspace/ }).click()
    await expect(dialog.getByPlaceholder('Workspace to move the tab to')).toBeFocused()
    await closesBack('a command’s value step')

    await win.keyboard.type('after-toggle\n')
    await expect
      .poll(async () =>
        (await rows.innerText()).split('\n').filter((l) => l.trim() === 'after-toggle'),
      )
      .toHaveLength(2)
    await expect(rows).not.toContainText('^[')
  } finally {
    await app.close()
  }
})

test('Search Everywhere opens a file at the line typed after its name, and lists matching text lines that open at their line', async () => {
  const { app, win } = await launchWithNotes()
  try {
    const search = win.getByRole('dialog', { name: 'Search everywhere' })
    await focusTerminal(win)

    await win.keyboard.press('Shift')
    await win.keyboard.press('Shift')
    await expect(search.getByRole('combobox')).toBeFocused()
    await win.keyboard.type('todo.md:2')
    await search.getByRole('option', { name: /^todo\.md/ }).click()
    await expect(search).toBeHidden()
    await expect(win.locator('.monaco-editor .view-lines').first()).toContainText('second line', {
      timeout: 15_000,
    })
    await expect.poll(() => cursorLine(win)).toBe('second line')

    await win.keyboard.press('Shift')
    await win.keyboard.press('Shift')
    await expect(search.getByRole('combobox')).toBeFocused()
    await win.keyboard.type('needle')
    const line = search.getByRole('option', { name: /^todo\.md:3/ })
    await expect(line).toContainText('find the needle here', { timeout: 15_000 })
    await expect(
      search.getByRole('option', { name: 'Search text in files for “needle”' }),
    ).toBeVisible()
    await line.click()
    await expect(search).toBeHidden()
    await expect.poll(() => cursorLine(win)).toBe('find the needle here')
  } finally {
    await app.close()
  }
})
