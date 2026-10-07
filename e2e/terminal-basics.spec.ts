import { _electron as electron, expect, test } from './test'
import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'

async function launch() {
  const app = await electron.launch(isolatedLaunch())
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const rows = win.locator('.xterm-rows').first()
  await openWorkspace(win)
  await win.locator('.xterm').first().click()
  return { app, win, rows }
}

test('Ctrl+K reaches the shell as readline kill-line', async () => {
  test.setTimeout(60_000)
  const { app, win, rows } = await launch()
  try {
    await win.keyboard.type('echo ostia_kk')
    await win.keyboard.press('Control+a')
    await win.keyboard.press('Control+k')
    await win.keyboard.type('echo ostia_$((20+22))_ok')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_42_ok', { timeout: 15_000 })
    await expect(rows).not.toContainText('ostia_kk')
    await expect(win.getByRole('dialog')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a pane shell reports a 256-color, truecolor terminal so TUIs keep their highlight colors', async () => {
  test.setTimeout(60_000)
  const { app, win, rows } = await launch()
  try {
    await win.keyboard.type('echo "term=$TERM color=$COLORTERM"')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('term=xterm-256color color=truecolor', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('the palette chord opens the command palette from a focused terminal', async () => {
  const { app, win } = await launch()
  try {
    await win.keyboard.press(chords.palette)
    await expect(win.getByRole('dialog')).toBeVisible({ timeout: 5_000 })
  } finally {
    await app.close()
  }
})

test('the find chord opens the find bar and Escape closes it', async () => {
  test.setTimeout(60_000)
  const { app, win, rows } = await launch()
  try {
    await win.keyboard.type('echo ostia_find_target')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_find_target', { timeout: 15_000 })

    await win.keyboard.press(chords.find)
    const input = win.getByLabel('Find in terminal')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await expect(input).toBeFocused()
    await input.fill('ostia_find_target')
    await expect(win.locator('.term-find-count')).toHaveText(/\d+\/\d+|\d+/, { timeout: 5_000 })

    await input.press('Escape')
    await expect(input).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('Clear Terminal clears the screen, keeps the scrollback, and the shell redraws its prompt', async () => {
  test.setTimeout(60_000)
  const { app, win, rows } = await launch()
  try {
    await win.keyboard.type('echo ostia_before_clear')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_before_clear', { timeout: 15_000 })

    await win.keyboard.press(chords.palette)
    await win.keyboard.type('Clear Terminal')
    await waitForPaletteSelection(win, 'Clear Terminal')
    await win.keyboard.press('Enter')
    await expect(rows).not.toContainText('ostia_before_clear', { timeout: 15_000 })

    await win.locator('.xterm').first().click()
    await win.keyboard.type('echo ostia_after_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_after_42', { timeout: 15_000 })

    await win.locator('.xterm').first().hover()
    await win.mouse.wheel(0, -2_000)
    await expect(rows).toContainText('ostia_before_clear', { timeout: 5_000 })
  } finally {
    await app.close()
  }
})
