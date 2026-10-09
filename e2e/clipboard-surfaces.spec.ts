import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { chords, isMac } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

const RED_DOT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

const READ_ONE_BYTE =
  'sh -c \'stty raw -echo; echo reading_$((3+4)); b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d " "); stty sane; echo byte_$b\''

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
  app.evaluate(async ({ clipboard, ClipboardItem }, url) => {
    clipboard.clear()
    const png = new Blob([Buffer.from(url.split(',')[1], 'base64')], { type: 'image/png' })
    await clipboard.write([new ClipboardItem({ 'image/png': png })])
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
    await win.keyboard.type('echo ostiacopyword')
    await win.keyboard.press('Enter')
    await expect(rows.locator('> div', { hasText: /^ostiacopyword/ })).toHaveCount(1)
    await selectTerminalWord(win, 'ostiacopyword')
    await win.keyboard.press(chords.copy)
    await expect.poll(() => readClipboard(app)).toBe('ostiacopyword')

    await writeClipboard(app, 'echo pasted_$((6*7))')
    await win.keyboard.press(chords.paste)
    await expect(rows).toContainText('echo pasted_')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pasted_42')

    await win.keyboard.type(READ_ONE_BYTE)
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('reading_7')
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
    await expect(rows).toContainText('reading_7')
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
    await expect(palette).toHaveValue('>')
    await win.keyboard.type('palette_text')
    await win.keyboard.press(chords.selectAll)
    await win.keyboard.press(chords.copy)
    await expect.poll(() => readClipboard(app)).toBe('>palette_text')
    await writeClipboard(app, 'field_pasted')
    await win.keyboard.press(chords.paste)
    await expect(palette).toHaveValue('field_pasted')
  } finally {
    await app.close()
  }
})

interface GuestClipboardRecord {
  inputs: string[]
  edits: string[]
  hostMessages: string[]
}

const GUEST_PAGE_STATE = `(() => {
  const source = document.getElementById('source')
  const sink = document.getElementById('sink')
  return {
    hasFocus: document.hasFocus(),
    visibility: document.visibilityState,
    activeElement: document.activeElement && document.activeElement.id,
    sourceSelection: [source.selectionStart, source.selectionEnd],
    pageSelection: String(getSelection()),
    sinkValue: sink.value,
  }
})()`

const recordGuestClipboard = (app: ElectronApplication, url: string) =>
  app.evaluate(({ webContents }, url) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
    if (!guest) return
    const record: GuestClipboardRecord = { inputs: [], edits: [], hostMessages: [] }
    ;(globalThis as { guestClipboardRecord?: GuestClipboardRecord }).guestClipboardRecord = record
    guest.on('before-input-event', (event, input) => {
      const modifiers = [
        input.control ? 'ctrl' : '',
        input.shift ? 'shift' : '',
        input.alt ? 'alt' : '',
        input.meta ? 'meta' : '',
      ].filter(Boolean)
      record.inputs.push(
        `${input.type} ${input.key} [${modifiers.join('+')}] prevented=${event.defaultPrevented}`,
      )
    })
    for (const edit of ['copy', 'paste', 'pasteAndMatchStyle'] as const) {
      const run = guest[edit].bind(guest)
      guest[edit] = () => {
        record.edits.push(edit)
        run()
      }
    }
    const host = guest.hostWebContents
    if (!host) return
    const send = host.send.bind(host)
    host.send = (channel, ...args) => {
      if (channel.startsWith('guest-chords:')) record.hostMessages.push(channel)
      send(channel, ...args)
    }
  }, url)

const guestClipboardState = (app: ElectronApplication, url: string) =>
  app.evaluate(
    async ({ webContents, BrowserWindow, clipboard }, { url, pageState }) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
      const host = guest?.hostWebContents
      return {
        record: (globalThis as { guestClipboardRecord?: GuestClipboardRecord })
          .guestClipboardRecord,
        guestFound: guest !== undefined,
        guestFocused: guest?.isFocused(),
        hostFocused: host?.isFocused(),
        windowFocused: BrowserWindow.getAllWindows().map((w) => w.isFocused()),
        guestUrls: webContents
          .getAllWebContents()
          .filter((wc) => wc.getType() === 'webview')
          .map((wc) => wc.getURL()),
        clipboardFormats: (await clipboard.read()).flatMap((item) => item.types),
        clipboardText: await clipboard.readText(),
        page: await guest?.executeJavaScript(pageState).catch((error) => String(error)),
      }
    },
    { url, pageState: GUEST_PAGE_STATE },
  )

async function attachingGuestState(
  step: string,
  app: ElectronApplication,
  url: string,
  check: () => Promise<void>,
): Promise<void> {
  try {
    await check()
  } catch (error) {
    const state = await guestClipboardState(app, url).catch((failed) => ({
      failed: String(failed),
    }))
    await test.info().attach(`guest-clipboard-${step}`, {
      body: JSON.stringify(state, null, 2),
      contentType: 'application/json',
    })
    throw error
  }
}

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
    if (isMac) {
      const roles = await app.evaluate(({ Menu }) => {
        const found: string[] = []
        const walk = (items: Electron.MenuItem[]) => {
          for (const item of items) {
            if (item.role) found.push(String(item.role).toLowerCase())
            if (item.submenu) walk(item.submenu.items)
          }
        }
        walk(Menu.getApplicationMenu()?.items ?? [])
        return found
      })
      expect(roles, 'macOS copies and pastes in a guest through the Edit menu roles').toEqual(
        expect.arrayContaining(['copy', 'paste']),
      )
      const editAction = (selector: string) =>
        app.evaluate(({ Menu }, action) => Menu.sendActionToFirstResponder(action), selector)
      await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        electronApp.focus({ steal: true })
        BrowserWindow.getAllWindows()[0]?.focus()
      })
      await win.locator('.pane-slot:not([data-hidden]) webview').click()
      await guestRun("document.getElementById('source').select()")
      await editAction('copy:')
      await expect.poll(() => readClipboard(app)).toBe('guest_copy')
      await writeClipboard(app, 'guest_pasted')
      await guestRun("document.getElementById('sink').focus()")
      await editAction('paste:')
      await expect
        .poll(() => guestRun("document.getElementById('sink').value"))
        .toBe('guest_pasted')
      return
    }
    await recordGuestClipboard(app, url)
    await guestRun("document.getElementById('source').select()")
    await guestChord('C')
    await attachingGuestState('copy', app, url, () =>
      expect.poll(() => readClipboard(app)).toBe('guest_copy'),
    )

    await writeClipboard(app, 'guest_pasted')
    await guestRun("document.getElementById('sink').focus()")
    await guestChord('V')
    await attachingGuestState('paste', app, url, () =>
      expect.poll(() => guestRun("document.getElementById('sink').value")).toBe('guest_pasted'),
    )
  } finally {
    await app.close()
    server.close()
  }
})
