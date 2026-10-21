import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fastFrames, SLOW_FRAME_MS, slowFrames } from './frames'
import { openWorkspace, waitForPaletteSelection } from './helpers'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  launchShared,
  type Page,
  test,
} from './test'

test.describe.configure({ mode: 'serial' })

const cursorLine = (win: Page) =>
  win.evaluate(() => {
    const cursor = document.querySelector('.monaco-editor .cursors-layer .cursor') as HTMLElement
    const lines = [...document.querySelectorAll('.monaco-editor .view-lines .view-line')]
    const top = cursor?.getBoundingClientRect().top
    const line = lines.find((el) => Math.abs(el.getBoundingClientRect().top - top) < 2)
    return line?.textContent?.replaceAll('\u00a0', ' ')
  })

const OPENERS: [string, (win: Page) => Promise<void>][] = [
  ['the chord', (win) => win.keyboard.press(chords.palette)],
  ['F1', (win) => win.keyboard.press('F1')],
  [
    'Shift twice',
    async (win) => {
      await win.keyboard.press('Shift')
      await win.keyboard.press('Shift')
    },
  ],
]

function notesLaunch(): ReturnType<typeof isolatedLaunch> {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'notes'), { recursive: true })
  writeFileSync(
    join(home, 'notes', 'todo.md'),
    'first line\nsecond line\nfind the needle here\nlast line\n',
  )
  const launch = isolatedLaunch(dataHome)
  return { ...launch, env: { ...launch.env, HOME: home } }
}

async function startCat(win: Page): Promise<void> {
  await win.locator('.xterm').first().click()
  await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
  await win.keyboard.type('cat -v\n')
}

async function shellSawNoEscape(win: Page, marker: string): Promise<void> {
  const rows = win.locator('.xterm-rows').first()
  await expect(win.locator('.xterm-helper-textarea').first(), marker).toBeFocused()
  await win.keyboard.type(`${marker}\n`)
  await expect
    .poll(async () => (await rows.innerText()).split('\n').filter((l) => l.trim() === marker))
    .toHaveLength(2)
  await expect(rows, marker).not.toContainText('^[')
}

let app: ElectronApplication | undefined
let win: Page

test.beforeAll(async () => {
  app = await launchShared(notesLaunch())
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await startCat(win)
})

test.afterAll(async () => {
  await app?.close()
})

test('Escape right after the palette chord in a terminal closes the palette and never reaches the shell', {
  tag: '@core',
}, async () => {
  await slowFrames(win)
  try {
    await win.keyboard.press(chords.palette)
    await win.keyboard.press('Escape')
    await expect(win.getByRole('dialog', { name: 'Command palette' })).toBeHidden({
      timeout: SLOW_FRAME_MS * 4,
    })
  } finally {
    await fastFrames(win)
  }
  await shellSawNoEscape(win, 'after-palette')
})

test('the palette opens from the chord, F1 and Shift twice in a terminal, toggles closed, and Escape closes it without the shell getting the key', async () => {
  const dialog = win.getByRole('dialog')
  const input = dialog.getByRole('combobox')
  const closesBack = async (state: string): Promise<void> => {
    await win.keyboard.press('Escape')
    await expect(dialog, state).toBeHidden()
    await expect(win.locator('.xterm-helper-textarea').first(), state).toBeFocused()
  }

  for (const [name, open] of OPENERS) {
    await open(win)
    await expect(input, name).toBeFocused()
    await closesBack(`${name}, just opened`)

    await open(win)
    await expect(input, name).toBeFocused()
    await win.keyboard.type('needle')
    await closesBack(`${name}, after typing`)
  }

  await win.keyboard.press('F1')
  await expect(input).toHaveValue('>')
  await win.keyboard.press('F1')
  await expect(dialog).toBeHidden()
  await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()

  await win.keyboard.press(chords.palette)
  await expect(input).toBeFocused()
  await win.keyboard.type('needle')
  await win.keyboard.press(chords.palette)
  await expect(dialog).toBeHidden()
  await shellSawNoEscape(win, 'after-toggle')
  await expect(win.locator('.xterm-rows').first()).not.toContainText('needle')

  await win.keyboard.press('Shift')
  await win.keyboard.press('Shift')
  await expect(
    win.getByRole('dialog', { name: 'Search everywhere' }).getByRole('combobox'),
  ).toBeFocused()
  await expect(win.locator('.xterm')).toHaveCount(1)
  await win.keyboard.type('Split Pane Right')
  await waitForPaletteSelection(win, 'Split Pane Right')
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm')).toHaveCount(2)
  await expect(win.locator('.xterm-rows').first()).not.toContainText('Split Pane Right')
  await win.keyboard.press(chords.closePane)
  await expect(win.locator('.xterm')).toHaveCount(1)
})

test('Search Everywhere opens a file at the line typed after its name', async () => {
  const search = win.getByRole('dialog', { name: 'Search everywhere' })
  await win.locator('.xterm').first().click()
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
})

test('the palette opens and Escape closes it over an editor and a browser page, each getting its keyboard back untouched', async () => {
  test.setTimeout(90_000)
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(
      '<title>Escape page</title><input id="field" autofocus><script>addEventListener("keydown", (e) => { if (e.key === "Escape") document.title = "page got Escape" }, true)</script>',
    )
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  try {
    const dialog = win.getByRole('dialog')
    const input = dialog.getByRole('combobox')
    const search = win.getByRole('dialog', { name: 'Search everywhere' })
    await win.keyboard.press('Shift')
    await win.keyboard.press('Shift')
    await win.keyboard.type('todo.md')
    await search.getByRole('option', { name: /^todo\.md/ }).click()
    await expect(search).toBeHidden()
    const lines = win.locator('.monaco-editor .view-lines').first()
    await expect(lines).toContainText('find the needle here', { timeout: 15_000 })
    for (const [name, open] of OPENERS) {
      await lines.click()
      await open(win)
      await expect(input, name).toBeFocused()
      await expect(win.locator('.quick-input-widget:visible'), name).toHaveCount(0)
      await win.keyboard.press('Escape')
      await expect(dialog, name).toBeHidden()
      await expect(win.locator('.monaco-editor .native-edit-context').first(), name).toBeFocused()
    }
    await lines.click()
    await win.keyboard.press('F1')
    await expect(input).toBeFocused()
    await win.keyboard.press('F1')
    await expect(dialog).toBeHidden()
    await expect(win.locator('.monaco-editor .native-edit-context').first()).toBeFocused()
    await win.keyboard.type('typed after escape ')
    await expect(lines).toContainText('typed after escape')

    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill(url)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /Escape page/ })).toBeVisible({ timeout: 15_000 })
    await win.locator('.pane-slot:not([data-hidden]) webview').click()
    await expect(win.locator('.pane-slot:not([data-hidden]) webview')).toBeFocused()
    await app?.evaluate(({ webContents }, url) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
      for (const type of ['keyDown', 'keyUp'] as const) {
        guest?.sendInputEvent({ type, keyCode: 'F1' })
      }
    }, url)
    await expect(input).toBeFocused()
    await win.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(win.locator('.pane-slot:not([data-hidden]) webview')).toBeFocused()
    const title = await app?.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
          ?.executeJavaScript('document.title'),
      url,
    )
    expect(title).toBe('Escape page')
  } finally {
    server.close()
  }
})

test('Escape closes the palette in a second window, and its shell never gets it', async () => {
  const second = await electron.launch(notesLaunch())
  try {
    const first = await second.firstWindow()
    await first.waitForLoadState('domcontentloaded')
    await openWorkspace(first)
    await startCat(first)
    await first.locator('.rail-row').first().click({ button: 'right' })
    const [moved] = await Promise.all([
      second.waitForEvent('window'),
      first.getByRole('menuitem', { name: 'Move to new window' }).click(),
    ])
    await moved.waitForLoadState('domcontentloaded')
    const dialog = moved.getByRole('dialog')
    await moved.locator('.xterm').first().click()
    await expect(moved.locator('.xterm-helper-textarea').first()).toBeFocused()
    await moved.keyboard.press(chords.palette)
    await expect(dialog.getByRole('combobox')).toBeFocused()
    await moved.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await shellSawNoEscape(moved, 'after-second-window-escape')
  } finally {
    await second.close()
  }
})
