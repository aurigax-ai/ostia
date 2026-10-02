import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { chords, isMac } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

const RED_DOT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

const READ_ONE_BYTE =
  'sh -c \'stty raw -echo; b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d " "); stty sane; echo byte_$b\''

interface Launched {
  app: ElectronApplication
  win: Page
  home: string
}

async function launch(
  settings: { clipboardKeys?: 'shift' | 'smart'; inputMode?: 'terminal' | 'editor' } = {},
): Promise<Launched> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: settings.inputMode ?? 'terminal' },
    terminal: { clipboardKeys: settings.clipboardKeys ?? 'shift' },
  })
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch(launchOptions)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win, home: launchOptions.home }
}

const writeClipboard = (app: ElectronApplication, text: string) =>
  app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)

const readClipboard = (app: ElectronApplication) =>
  app.evaluate(({ clipboard }) => clipboard.readText())

const writeClipboardImage = (app: ElectronApplication) =>
  app.evaluate(({ clipboard, nativeImage }, url) => {
    clipboard.clear()
    clipboard.writeImage(nativeImage.createFromDataURL(url))
  }, RED_DOT_PNG)

async function selectTerminalWord(win: Page, word: string): Promise<void> {
  const row = win
    .locator('.xterm-rows > div')
    .filter({ hasText: new RegExp(`^${word}`) })
    .first()
  const box = await row.boundingBox()
  if (!box) throw new Error('row not visible')
  await win.mouse.dblclick(box.x + 12, box.y + box.height / 2)
}

test('the copy and paste chords work in a terminal and paste an image as Ctrl+V for a program', async () => {
  const { app, win } = await launch()
  try {
    const rows = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()
    await win.keyboard.type('echo pinecopyword')
    await win.keyboard.press('Enter')
    await expect(rows.locator('> div', { hasText: /^pinecopyword/ })).toHaveCount(1)
    await selectTerminalWord(win, 'pinecopyword')
    await win.keyboard.press(chords.copy)
    await expect.poll(() => readClipboard(app)).toBe('pinecopyword')

    await writeClipboard(app, 'echo pasted_$((6*7))')
    await win.keyboard.press(chords.paste)
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pasted_42')

    await win.keyboard.type(READ_ONE_BYTE)
    await win.keyboard.press('Enter')
    await writeClipboardImage(app)
    await win.keyboard.press(chords.paste)
    await expect(rows).toContainText('byte_16', { timeout: 10_000 })
  } finally {
    await app.close()
  }
})

test('smart Ctrl+V hands an image-only clipboard to the program as Ctrl+V', async () => {
  test.skip(isMac, 'smart Ctrl+C and Ctrl+V do not exist on macOS, which uses the Cmd keys')
  const { app, win } = await launch({ clipboardKeys: 'smart' })
  try {
    const rows = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()
    await win.keyboard.type(READ_ONE_BYTE)
    await win.keyboard.press('Enter')
    await writeClipboardImage(app)
    await win.keyboard.press('Control+v')
    await expect(rows).toContainText('byte_16', { timeout: 10_000 })
  } finally {
    await app.close()
  }
})

test('the input editor copies on the chord and on smart Ctrl+C, and pastes on both', async () => {
  test.skip(isMac, 'smart Ctrl+C and Ctrl+V do not exist on macOS, which uses the Cmd keys')
  const { app, win } = await launch({ clipboardKeys: 'smart', inputMode: 'editor' })
  try {
    const input = win.getByRole('textbox', { name: 'Command input' })
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.click()
    await win.keyboard.type('echo editor_copy')
    await win.keyboard.press('Shift+Home')
    await win.keyboard.press(chords.copy)
    await expect.poll(() => readClipboard(app)).toBe('echo editor_copy')

    await writeClipboard(app, 'nothing')
    await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 16))
    await win.keyboard.press('Control+c')
    await expect.poll(() => readClipboard(app)).toBe('editor_copy')
    await expect(input).toHaveValue('echo editor_copy')

    await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0))
    await win.keyboard.press('Control+c')
    await expect(input).toHaveValue('')

    await writeClipboard(app, 'echo from_chord')
    await win.keyboard.press(chords.paste)
    await expect(input).toHaveValue('echo from_chord')
    await win.keyboard.press('Control+c')
    await writeClipboard(app, 'echo from_ctrl_v\u0007')
    await win.keyboard.press('Control+v')
    await expect(input).toHaveValue('echo from_ctrl_v')
  } finally {
    await app.close()
  }
})

test('the copy and paste chords work in Monaco and in a text field', async () => {
  const { app, win, home } = await launch()
  try {
    writeFileSync(join(home, 'notes.txt'), 'monaco_text\n')
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await win.locator('.file-row').filter({ hasText: 'notes.txt' }).click()
    const lines = win.locator('.monaco-editor .view-lines').first()
    await expect(lines).toContainText('monaco_text', { timeout: 15_000 })
    await lines.click()
    await win.keyboard.press(chords.selectAll)
    await win.keyboard.press(chords.copy)
    await expect.poll(() => readClipboard(app)).toBe('monaco_text\n')

    await win.keyboard.press(chords.documentEnd)
    await writeClipboard(app, 'monaco_pasted')
    await win.keyboard.press(chords.paste)
    await expect(lines).toContainText('monaco_pasted')

    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('combobox').first()
    await expect(palette).toBeFocused()
    await win.keyboard.type('palette_text')
    await win.keyboard.press(chords.selectAll)
    await win.keyboard.press(chords.copy)
    await expect.poll(() => readClipboard(app)).toBe('palette_text')
    await writeClipboard(app, 'field_pasted')
    await win.keyboard.press(chords.paste)
    await expect(palette).toHaveValue('field_pasted')
  } finally {
    await app.close()
  }
})

test('the copy and paste chords work inside a browser pane', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(
      '<title>Clipboard page</title><input id="source" value="guest_copy"><textarea id="sink"></textarea>',
    )
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const { app, win } = await launch()
  const guestRun = (code: string) =>
    app.evaluate(
      ({ webContents }, { code, url }) =>
        webContents
          .getAllWebContents()
          .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
          ?.executeJavaScript(code),
      { code, url },
    )
  const guestChord = (keyCode: string) =>
    app.evaluate(
      ({ webContents }, { keyCode, url, modifiers }) => {
        const guest = webContents
          .getAllWebContents()
          .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
        for (const type of ['keyDown', 'keyUp'] as const) {
          guest?.sendInputEvent({ type, keyCode, modifiers })
        }
      },
      {
        keyCode,
        url,
        modifiers: isMac ? ['meta' as const] : ['control' as const, 'shift' as const],
      },
    )
  try {
    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill(url)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /Clipboard page/ })).toBeVisible({ timeout: 15_000 })
    await win.locator('.pane-slot:not([data-hidden]) webview').click()
    await expect.poll(() => guestRun('document.hasFocus()')).toBe(true)
    await guestRun("document.getElementById('source').select()")
    await guestChord('C')
    await expect.poll(() => readClipboard(app)).toBe('guest_copy')

    await writeClipboard(app, 'guest_pasted')
    await guestRun("document.getElementById('sink').focus()")
    await guestChord('V')
    await expect.poll(() => guestRun("document.getElementById('sink').value")).toBe('guest_pasted')
  } finally {
    await app.close()
    server.close()
  }
})
