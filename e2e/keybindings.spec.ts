import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { isMac } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

async function openKeyboardSettings(win: Page) {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Keyboard' }).click()
  return settings
}

function paletteRow(win: Page) {
  return win
    .getByRole('region', { name: 'Keyboard' })
    .getByRole('row')
    .filter({ hasText: 'palette.toggle' })
}

async function closeSettings(win: Page) {
  await win.keyboard.press('Escape')
  await expect(win.getByRole('region', { name: 'Settings' })).toHaveCount(0)
}

async function focusTerminal(win: Page) {
  await win.locator('.xterm').first().click()
  await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
}

const palette = (win: Page) => win.getByRole('dialog', { name: 'Command palette' })

test('a rebound palette chord works from a focused terminal, refuses Ctrl+R, and resets', async () => {
  test.skip(isMac, 'the macOS chords are covered by the next test')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await openKeyboardSettings(win)
    await expect(paletteRow(win)).toContainText('Ctrl+Shift+P')
    await win.getByRole('button', { name: 'Record a shortcut for Command Palette' }).click()
    await win.keyboard.press('Control+Shift+Y')
    await expect(paletteRow(win)).toContainText('Ctrl+Shift+Y')

    await win.getByRole('button', { name: 'Record a shortcut for Command Palette' }).click()
    await win.keyboard.press('Control+r')
    await expect(paletteRow(win).getByRole('alert')).toContainText(
      'Ctrl+R can’t be used: plain Ctrl keys belong to the shell',
    )
    await win.keyboard.press('Escape')
    await expect(paletteRow(win)).toContainText('Ctrl+Shift+Y')
    await closeSettings(win)

    await focusTerminal(win)
    await win.keyboard.press('Control+Shift+P')
    await win.waitForTimeout(400)
    await expect(palette(win)).toHaveCount(0)
    await win.keyboard.press('Control+Shift+Y')
    await expect(palette(win)).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(palette(win)).toHaveCount(0)

    await openKeyboardSettings(win)
    await win.getByRole('button', { name: 'Reset Command Palette' }).click()
    await expect(paletteRow(win)).toContainText('Ctrl+Shift+P')
    await closeSettings(win)

    await focusTerminal(win)
    await win.keyboard.press('Control+Shift+Y')
    await win.waitForTimeout(400)
    await expect(palette(win)).toHaveCount(0)
    await win.keyboard.press('Control+Shift+P')
    await expect(palette(win)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('on macOS the palette is Cmd+K, a rebound chord works from a terminal, a Ctrl chord is refused, and it resets', async () => {
  test.skip(!isMac, 'the Cmd chords exist only on macOS')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await openKeyboardSettings(win)
    await expect(paletteRow(win)).toContainText('⌘K')
    await win.getByRole('button', { name: 'Record a shortcut for Command Palette' }).click()
    await win.keyboard.press('Meta+Shift+Y')
    await expect(paletteRow(win)).toContainText('Y')
    await expect(paletteRow(win)).not.toContainText('⌘K')

    await win.getByRole('button', { name: 'Record a shortcut for Command Palette' }).click()
    await win.keyboard.press('Control+Shift+y')
    await expect(paletteRow(win).getByRole('alert')).toContainText('it needs ⌘')
    await win.keyboard.press('Escape')
    await closeSettings(win)

    await focusTerminal(win)
    await win.keyboard.press('Meta+k')
    await win.waitForTimeout(400)
    await expect(palette(win)).toHaveCount(0)
    await win.keyboard.press('Meta+Shift+Y')
    await expect(palette(win)).toBeVisible()
    await expect(win.getByRole('combobox').first()).toBeFocused()
    await win.keyboard.press('Escape')
    await expect(palette(win)).toHaveCount(0)

    await openKeyboardSettings(win)
    await win.getByRole('button', { name: 'Reset Command Palette' }).click()
    await expect(paletteRow(win)).toContainText('⌘K')
    await closeSettings(win)

    await focusTerminal(win)
    await win.keyboard.press('Meta+k')
    await expect(palette(win)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('on macOS Cmd+Backspace deletes the typed line in the shell, as in Terminal and iTerm', async () => {
  test.skip(!isMac, 'Cmd+Backspace is a macOS line-editing key')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await focusTerminal(win)
    const rows = win.locator('.xterm-rows').first()

    await win.keyboard.type('echo pine_wrong_line')
    await expect(rows).toContainText('echo pine_wrong_line')
    await win.keyboard.press('Meta+Backspace')
    await win.keyboard.type('echo pine_$((40+2))_ok')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_42_ok')
    await expect(rows).not.toContainText('pine_wrong_line')
    expect(app.windows()).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('on macOS Cmd+W closes the focused pane and leaves the app running, and the menu closes the window with Cmd+Shift+W', async () => {
  test.skip(!isMac, 'the macOS application menu and Cmd chords only exist on macOS')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    const accelerators = await app.evaluate(({ Menu }) => {
      const found: { label: string; role: string; accelerator: string }[] = []
      const walk = (menu: Electron.Menu | null): void => {
        for (const item of menu?.items ?? []) {
          found.push({
            label: item.label,
            role: item.role ?? '',
            accelerator: String(item.accelerator ?? ''),
          })
          walk(item.submenu ?? null)
        }
      }
      walk(Menu.getApplicationMenu())
      return found
    })
    expect(accelerators.map((item) => item.accelerator)).not.toContain('CmdOrCtrl+W')
    expect(accelerators.map((item) => item.accelerator)).not.toContain('Cmd+W')
    expect(accelerators.find((item) => item.role === 'close')?.accelerator).toBe('Cmd+Shift+W')

    await focusTerminal(win)
    await win.keyboard.press('Meta+Alt+Backslash')
    await expect(win.locator('.xterm')).toHaveCount(2)
    await win.locator('.xterm').nth(1).click()
    await win.keyboard.press('Meta+w')
    await expect(win.locator('.xterm')).toHaveCount(1)
    expect(win.isClosed()).toBe(false)
    expect(app.windows()).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('on macOS the app menu is named Ostia, its Settings item opens Settings, and it has no Reload', async () => {
  test.skip(!isMac, 'the macOS application menu only exists on macOS')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    const menu = await app.evaluate(({ Menu }) => {
      const items: { label: string; role: string; accelerator: string }[] = []
      const walk = (m: Electron.Menu | null): void => {
        for (const item of m?.items ?? []) {
          items.push({
            label: item.label,
            role: item.role ?? '',
            accelerator: String(item.accelerator ?? ''),
          })
          walk(item.submenu ?? null)
        }
      }
      walk(Menu.getApplicationMenu())
      return items
    })
    expect(menu[0].label).toBe('Ostia')
    expect(menu.map((i) => i.label).filter((l) => /pine/i.test(l))).toEqual([])
    expect(menu.map((i) => i.role)).not.toContain('reload')
    expect(menu.map((i) => i.role)).not.toContain('forcereload')
    expect(menu.map((i) => i.accelerator)).not.toContain('CmdOrCtrl+R')
    expect(menu.find((i) => i.label === 'Settings…')?.accelerator).toBe('Cmd+,')

    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.getMenuItemById('settings')?.click(),
    )
    await expect(win.getByRole('region', { name: 'Settings' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('on macOS the cmux keymap is opt-in: picking it makes ⌘D split the focused terminal', async () => {
  test.skip(!isMac, 'the cmux keymap is offered only on macOS')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await expect(win.locator('.xterm')).toHaveCount(1)

    const settings = await openKeyboardSettings(win)
    const picker = settings.getByRole('combobox', { name: 'Keymap' })
    await expect(picker).toContainText('Default')
    await expect(paletteRow(win)).toContainText('⌘K')
    await picker.click()
    await win.getByRole('option', { name: 'macOS (cmux)' }).click()
    await expect(picker).toContainText('macOS (cmux)')
    await expect(paletteRow(win)).toContainText('⌘⇧P')
    await closeSettings(win)

    await focusTerminal(win)
    await win.keyboard.press('Meta+d')
    await expect(win.locator('.xterm')).toHaveCount(2)
  } finally {
    await app.close()
  }
})
