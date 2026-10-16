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

test('the palette chord closes the palette and gives the keyboard back to the terminal', async () => {
  const { app, win } = await launchWithNotes()
  try {
    const rows = win.locator('.xterm-rows').first()
    const dialog = win.getByRole('dialog')
    await focusTerminal(win)
    await win.keyboard.type('cat -v\n')

    await win.keyboard.press(chords.palette)
    await expect(dialog.getByRole('combobox')).toBeFocused()
    await win.keyboard.type('needle')
    await win.keyboard.press(chords.palette)
    await expect(dialog).toBeHidden()
    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()

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

test('Search Everywhere opens a file at the line typed after its name', async () => {
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
  } finally {
    await app.close()
  }
})
