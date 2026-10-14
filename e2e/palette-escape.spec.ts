import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { startFakeProvider } from './fakeProvider'
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
  writeFileSync(join(home, 'notes', 'todo.md'), 'first line\nfind the needle here\n')
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
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

test('Escape closes the palette from every way of opening it and every mode, and the shell never gets it', async () => {
  const { app, win } = await launchWithNotes()
  try {
    const dialog = win.getByRole('dialog')
    const input = dialog.getByRole('combobox')
    await startCat(win)

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

    for (const prefix of ['>', '', '@', '#', '/', '%', '?']) {
      await win.keyboard.press(chords.palette)
      await expect(input).toBeFocused()
      await input.fill(prefix)
      await closesBack(`prefix "${prefix}"`)
    }

    await win.keyboard.press(chords.palette)
    await expect(input).toBeFocused()
    await win.keyboard.type('Move Tab to Workspace')
    await dialog.getByRole('option', { name: /^Move Tab to Workspace/ }).click()
    await expect(dialog.getByPlaceholder('Workspace to move the tab to')).toBeFocused()
    await closesBack('a command’s value step')

    await shellSawNoEscape(win, 'after-escape')
  } finally {
    await app.close()
  }
})

test('Escape held until it repeats closes the palette once and none of its repeats reach the shell; the next press is the shell’s', async () => {
  const { app, win } = await launchWithNotes()
  try {
    const dialog = win.getByRole('dialog')
    const rows = win.locator('.xterm-rows').first()
    const textarea = win.locator('.xterm-helper-textarea').first()
    await startCat(win)

    for (const [name, open] of OPENERS) {
      await open(win)
      await expect(dialog.getByRole('combobox'), name).toBeFocused()
      await win.keyboard.down('Escape')
      await expect(dialog, name).toBeHidden()
      await expect(textarea, name).toBeFocused()
      await win.keyboard.down('Escape')
      await win.keyboard.down('Escape')
      await win.keyboard.up('Escape')
    }
    await shellSawNoEscape(win, 'after-held-escape')

    await win.keyboard.press('Escape')
    await expect(rows).toContainText('^[')
  } finally {
    await app.close()
  }
})

test('Escape while an input method is composing in the palette closes it, and the next Escape in a reopened palette closes it too', async () => {
  const { app, win } = await launchWithNotes()
  try {
    const dialog = win.getByRole('dialog')
    const input = dialog.getByRole('combobox')
    const cdp = await win.context().newCDPSession(win)
    await startCat(win)

    const compose = (text: string): Promise<unknown> =>
      cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      })

    for (const [name, open] of OPENERS) {
      await open(win)
      await expect(input, name).toBeFocused()
      await compose('ni')
      await expect(input, name).toHaveValue(/ni$/)
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Process',
        code: 'Escape',
        windowsVirtualKeyCode: 229,
        nativeVirtualKeyCode: 229,
      })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      })
      await expect(dialog, name).toBeHidden()
      await expect(win.locator('.xterm-helper-textarea').first(), name).toBeFocused()

      await open(win)
      await expect(input, name).toBeFocused()
      await expect(input, name).not.toHaveValue(/ni$/)
      await win.keyboard.press('Escape')
      await expect(dialog, `${name}, reopened`).toBeHidden()
    }

    await shellSawNoEscape(win, 'after-composing-escape')
  } finally {
    await app.close()
  }
})

test('Escape closes the palette opened over an editor, the input editor and a browser page, and gives each its keyboard back untouched', async () => {
  test.setTimeout(90_000)
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(
      '<title>Escape page</title><input id="field" autofocus><script>addEventListener("keydown", (e) => { if (e.key === "Escape") document.title = "page got Escape" }, true)</script>',
    )
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const { app, win } = await launchWithNotes()
  try {
    const dialog = win.getByRole('dialog')
    const input = dialog.getByRole('combobox')

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Terminal' }).click()
    await settings.getByRole('combobox', { name: 'Input mode' }).click()
    await win.getByRole('option', { name: 'Input editor' }).click()
    await expect(settings.getByRole('combobox', { name: 'Input mode' })).toContainText(
      'Input editor',
    )
    await win.keyboard.press('Escape')
    const draft = win.getByRole('textbox', { name: 'Command input' })
    await expect(draft).toBeVisible({ timeout: 15_000 })
    await draft.click()
    await win.keyboard.type('echo draft')
    for (const [name, open] of OPENERS) {
      await open(win)
      await expect(input, name).toBeFocused()
      await win.keyboard.press('Escape')
      await expect(dialog, name).toBeHidden()
      await expect(draft, name).toBeFocused()
      await expect(draft, name).toHaveValue('echo draft')
    }

    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await win.locator('.file-row').filter({ hasText: 'notes' }).click()
    await win.locator('.file-row').filter({ hasText: 'todo.md' }).click()
    const lines = win.locator('.monaco-editor .view-lines').first()
    await expect(lines).toContainText('find the needle here', { timeout: 15_000 })
    for (const [name, open] of OPENERS) {
      await lines.click()
      await open(win)
      await expect(input, name).toBeFocused()
      await win.keyboard.press('Escape')
      await expect(dialog, name).toBeHidden()
      await expect(win.locator('.monaco-editor .native-edit-context').first(), name).toBeFocused()
    }
    await win.keyboard.type('typed after escape ')
    await expect(lines).toContainText('typed after escape')

    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    await address.fill(url)
    await address.press('Enter')
    await expect(win.getByRole('tab', { name: /Escape page/ })).toBeVisible({ timeout: 15_000 })
    await win.locator('.pane-slot:not([data-hidden]) webview').click()
    const inGuest = <T>(script: string): Promise<T> =>
      app.evaluate(
        ({ webContents }, { url, script }) =>
          webContents
            .getAllWebContents()
            .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
            ?.executeJavaScript(script),
        { url, script },
      ) as Promise<T>
    await expect(win.locator('.pane-slot:not([data-hidden]) webview')).toBeFocused()
    await app.evaluate(({ webContents }, url) => {
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
    expect(await inGuest<string>('document.title')).toBe('Escape page')
  } finally {
    await app.close()
    server.close()
  }
})

test('Escape closes the palette in Ask mode and in a second window, and neither shell gets it', async () => {
  test.setTimeout(120_000)
  const provider = await startFakeProvider(() => 'An answer.')
  const { app, win } = await launchWithNotes()
  try {
    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Assistant', exact: true }).click()
    await settings.getByRole('button', { name: 'Add provider' }).click({ timeout: 30_000 })
    await win.getByRole('menuitem', { name: 'OpenAI-compatible', exact: true }).click()
    const card = settings.getByRole('listitem', { name: 'OpenAI-compatible' })
    const base = card.getByRole('textbox', { name: 'Base URL: OpenAI-compatible' })
    await base.fill(provider.url)
    await base.press('Enter')
    await expect(card.getByRole('status')).toHaveText('No models yet', { timeout: 15_000 })
    await card.getByRole('combobox', { name: 'Model id for OpenAI-compatible' }).click()
    await win.getByRole('option', { name: 'fake-small', exact: true }).click()
    await expect(card.getByRole('status')).toHaveText('Ready', { timeout: 15_000 })
    await expect(settings.getByRole('combobox', { name: 'Chat model' })).toContainText(
      'OpenAI-compatible · fake-small',
      { timeout: 15_000 },
    )
    await win.keyboard.press('Escape')

    const dialog = win.getByRole('dialog')
    await startCat(win)
    for (const [name, open] of OPENERS) {
      await open(win)
      await expect(dialog.getByRole('combobox'), name).toBeFocused()
      await win.keyboard.type('how do I list files')
      await win.keyboard.press('Tab')
      const question = dialog.getByRole('combobox', { name: 'Your question' })
      await expect(question, name).toBeFocused()
      await win.keyboard.press('Escape')
      await expect(dialog, name).toBeHidden()
      await expect(win.locator('.xterm-helper-textarea').first(), name).toBeFocused()
    }
    await shellSawNoEscape(win, 'after-ask-escape')

    await win.locator('.rail-row').first().click({ button: 'right' })
    const [second] = await Promise.all([
      app.waitForEvent('window'),
      win.getByRole('menuitem', { name: 'Move to new window' }).click(),
    ])
    await second.waitForLoadState('domcontentloaded')
    const moved = second.getByRole('dialog')
    await second.locator('.xterm').first().click()
    await expect(second.locator('.xterm-helper-textarea').first()).toBeFocused()
    for (const [name, open] of OPENERS) {
      await open(second)
      await expect(moved.getByRole('combobox'), name).toBeFocused()
      await second.keyboard.press('Escape')
      await expect(moved, name).toBeHidden()
    }
    await shellSawNoEscape(second, 'after-second-window-escape')
  } finally {
    await app.close()
    provider.close()
  }
})
