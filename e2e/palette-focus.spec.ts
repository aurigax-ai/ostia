import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { SLOW_FRAME_MS, fastFrames, slowFrames } from './frames'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('Escape right after the palette chord in a terminal closes the palette and never reaches the shell', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()
    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
    await win.keyboard.type('cat -v\n')

    await slowFrames(win)
    await win.keyboard.press(chords.palette)
    await win.keyboard.press('Escape')
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeHidden({ timeout: SLOW_FRAME_MS * 4 })
    await fastFrames(win)

    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
    await win.keyboard.type('after-palette\n')
    await expect
      .poll(async () =>
        (await rows.innerText()).split('\n').filter((l) => l.trim() === 'after-palette'),
      )
      .toHaveLength(2)
    await expect(rows).not.toContainText('^[')
  } finally {
    await app.close()
  }
})

test('the palette chord opens the palette on commands only, and removing the prefix lists everything', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()

    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    const input = palette.getByRole('combobox')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('>')
    await expect(palette.getByRole('option').first()).toBeVisible()
    await expect(palette.getByRole('group', { name: 'Workspaces' })).toHaveCount(0)
    await expect(palette.getByRole('group', { name: 'Tabs' })).toHaveCount(0)

    await win.keyboard.press('Backspace')
    await expect(palette.getByRole('group', { name: 'Workspaces' })).toBeVisible()
    await expect(palette.getByRole('group', { name: 'Tabs' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('Shift twice in a terminal opens Search Everywhere and runs the command picked there', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()
    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
    await win.keyboard.type('cat -v\n')

    await win.keyboard.press('Shift')
    await win.keyboard.press('Shift')
    const search = win.getByRole('dialog', { name: 'Search everywhere' })
    const input = search.getByRole('combobox')
    await expect(input).toBeFocused()
    await win.keyboard.type('Open Settings')
    await expect(search.getByRole('option').first()).toContainText('Open Settings')
    await win.keyboard.press('Enter')

    await expect(search).toBeHidden()
    await expect(win.getByRole('textbox', { name: 'Search settings' })).toBeVisible()
    await expect(rows).not.toContainText('Open Settings')
    await expect(rows).not.toContainText('^[')
  } finally {
    await app.close()
  }
})
