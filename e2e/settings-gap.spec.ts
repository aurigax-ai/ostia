import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from './test'
import { chords, isMac } from './chords'
import {
  DOM_RENDERER_SETTINGS,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
  testHome,
} from './dataHome'
import { openWorkspace } from './helpers'

async function launch(settings: object, inProjectFolder = false) {
  const dataHome = freshDataHome()
  const project = join(testHome(dataHome), 'project')
  mkdirSync(project, { recursive: true })
  const workspaces = inProjectFolder
    ? { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project }
    : DOM_RENDERER_SETTINGS.workspaces
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, workspaces, ...settings })
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

async function run(win: Page, command: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

test('terminal.shell starts new terminals in the chosen program with its arguments', async () => {
  const { app, win } = await launch({ terminal: { shell: '/bin/sh -i' } })
  try {
    await run(win, 'echo "shell=$0 flags=$-"')
    await expect(win.locator('.xterm-rows').first()).toContainText(/shell=\/bin\/sh flags=\S*i/, {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

test('an unusable terminal.shell falls back to the login shell', async () => {
  const { app, win } = await launch({ terminal: { shell: '"/bin/sh -i' } })
  try {
    const login = (process.env.SHELL ?? 'bash').split('/').pop()
    await run(win, 'echo "proc=$(basename $(ps -p $$ -o comm= | tr -d \' -\'))"')
    await expect(win.locator('.xterm-rows').first()).toContainText(`proc=${login}`, {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

test('a sandboxed workspace wraps the shell chosen in terminal.shell', async () => {
  const { app, win } = await launch({ terminal: { shell: '/bin/sh -i' } }, true)
  try {
    await win.locator('.rail-row').first().click({ button: 'right' })
    await win.getByRole('menuitemcheckbox', { name: 'Sandbox' }).click()
    const restart = win.getByRole('button', { name: 'Restart to apply' })
    await restart.click()
    await expect(restart).toHaveCount(0)
    const rows = win.locator('.xterm-rows').first()
    await expect(async () => {
      await win.keyboard.press('Control+C')
      await run(win, 'echo "sandbox=${HTTPS_PROXY:+on} flags=$-"')
      await expect(rows).toContainText(/sandbox=on flags=\S*i/, { timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
  } finally {
    await app.close()
  }
})

test('the primary selection takes only non-empty text up to the cap from the page', async () => {
  test.skip(isMac, 'the primary selection is X11 only')
  const { app, win } = await launch({})
  try {
    const send = (text: string) =>
      win.evaluate((t) => {
        ;(
          window as unknown as { ostia: { window: { writePrimarySelection: (s: string) => void } } }
        ).ostia.window.writePrimarySelection(t)
      }, text)
    const read = (which: 'selection' | 'clipboard') =>
      app.evaluate(
        ({ clipboard }, w) =>
          w === 'selection' ? clipboard.selection.readText() : clipboard.readText(),
        which,
      )
    await app.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('sentinel-clipboard')
      await clipboard.selection.writeText('sentinel-primary')
    })
    await send('')
    await send('x'.repeat(2 * 1024 * 1024))
    await win.waitForTimeout(300)
    expect(await read('selection')).toBe('sentinel-primary')
    await send('from-the-page')
    await expect.poll(() => read('selection')).toBe('from-the-page')
    expect(await read('clipboard')).toBe('sentinel-clipboard')
  } finally {
    await app.close()
  }
})

test('OSC 52 sets the clipboard only while terminal.osc52Write is on', async () => {
  const { app, win } = await launch({ terminal: { osc52Write: true } })
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'))
    await run(win, 'printf \'\\033]52;c;%s\\a\' "$(printf ostia-osc52 | base64)"')
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toBe('ostia-osc52')
    await run(win, "printf '\\033]52;c;?\\a'")
    await win.waitForTimeout(300)
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('ostia-osc52')
  } finally {
    await app.close()
  }
})

test('OSC 52 leaves the clipboard alone by default', async () => {
  const { app, win } = await launch({})
  try {
    await run(win, 'printf \'\\033]52;c;%s\\a\' "$(printf ostia-osc52-off | base64)"; echo osc-sent')
    await expect(win.locator('.xterm-rows').first()).toContainText('osc-sent')
    await win.waitForTimeout(300)
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).not.toBe('ostia-osc52-off')
  } finally {
    await app.close()
  }
})

test('workspaces.globalHotkey registers a system-wide shortcut and drops it when cleared', async () => {
  const { app, win } = await launch({ workspaces: { globalHotkey: 'Ctrl+Alt+F9' } })
  try {
    await expect
      .poll(() => app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Alt+F9')))
      .toBe(true)
    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Workspaces' }).click()
    await settings.getByRole('textbox', { name: 'Show or hide hotkey' }).fill('')
    await expect
      .poll(() => app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Ctrl+Alt+F9')))
      .toBe(false)
  } finally {
    await app.close()
  }
})

test('selecting terminal text fills the primary selection, and middle click pastes it unless turned off', async () => {
  test.skip(isMac, 'the primary selection is X11 only')
  const { app, win } = await launch({})
  try {
    await run(win, 'echo ostia-primary-word')
    const rows = win.locator('.xterm-rows').first()
    const line = rows.locator('div', { hasText: /^ostia-primary-word\s*$/ }).first()
    await expect(line).toBeAttached({ timeout: 15_000 })
    const box = await line.boundingBox()
    if (!box) throw new Error('no line box')
    await win.mouse.move(box.x + 2, box.y + box.height / 2)
    await win.mouse.down()
    await win.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 })
    await win.mouse.up()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.selection.readText()))
      .toContain('ostia')
    await expect(async () => {
      await app.evaluate(({ clipboard }) => clipboard.selection.writeText('echo from-primary'))
      await win.locator('.xterm').first().click({ button: 'middle' })
      await expect(rows).toContainText('echo from-primary', { timeout: 1000 })
    }).toPass({ timeout: 15_000 })
  } finally {
    await app.close()
  }

  const off = await launch({ terminal: { primarySelection: false } })
  try {
    await off.app.evaluate(({ clipboard }) => clipboard.selection.writeText('echo from-primary'))
    await off.win.locator('.xterm').first().click()
    await off.win.locator('.xterm').first().click({ button: 'middle' })
    await off.win.waitForTimeout(500)
    await expect(off.win.locator('.xterm-rows').first()).not.toContainText('from-primary')
  } finally {
    await off.app.close()
  }
})

test('default chords split a pane, move focus by direction and zoom it', async () => {
  const { app, win } = await launch({})
  try {
    await win.locator('.xterm').first().click()
    const panes = win.locator('.pane')
    await expect(panes).toHaveCount(1)
    const first = await panes.first().getAttribute('data-pane-id')

    await win.keyboard.press(chords.splitRight)
    await expect(panes).toHaveCount(2)
    const active = win.locator('.pane.active')
    await expect(active).not.toHaveAttribute('data-pane-id', first ?? '')
    const second = await active.getAttribute('data-pane-id')

    await win.keyboard.press(chords.focusLeft)
    await expect(active).toHaveAttribute('data-pane-id', first ?? '')
    await expect(active.locator('.xterm-helper-textarea')).toBeFocused()
    await win.keyboard.type('echo typed-in-left')
    await expect(win.locator(`.pane[data-pane-id="${first}"] .xterm-rows`)).toContainText(
      'echo typed-in-left',
    )

    await win.keyboard.press(chords.focusRight)
    await expect(active).toHaveAttribute('data-pane-id', second ?? '')

    await win.keyboard.press(chords.zoomPane)
    await expect(win.locator('.pane:visible')).toHaveCount(1)
    await win.keyboard.press(chords.zoomPane)
    await expect(win.locator('.pane:visible')).toHaveCount(2)
  } finally {
    await app.close()
  }
})
