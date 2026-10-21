import { isMac } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

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

async function focusTerminal(win: Page) {
  await win.locator('.xterm').first().click()
  await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
}

test('scrolling the Keyboard settings never gives the window a scrollbar of its own', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await openKeyboardSettings(win)
    await expect(paletteRow(win)).toBeVisible()

    const row = await paletteRow(win).elementHandle()
    const widths = await win.evaluate(async (target) => {
      const framesWatched = 30
      let narrowest = document.documentElement.clientWidth
      target?.scrollIntoView({ block: 'center' })
      for (let frame = 0; frame < framesWatched; frame++) {
        await new Promise((next) => requestAnimationFrame(next))
        narrowest = Math.min(narrowest, document.documentElement.clientWidth)
      }
      return { narrowest, window: window.innerWidth }
    }, row)
    expect(widths.narrowest).toBe(widths.window)
  } finally {
    await app.close()
  }
})

test(
  'on macOS Cmd+Backspace deletes the typed line in the shell, as in Terminal and iTerm',
  { tag: '@core' },
  async () => {
    test.skip(!isMac, 'Cmd+Backspace is a macOS line-editing key')
    const app = await electron.launch(isolatedLaunch())
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      await focusTerminal(win)
      const rows = win.locator('.xterm-rows').first()

      await win.keyboard.type('echo ostia_wrong_line')
      await expect(rows).toContainText('echo ostia_wrong_line')
      await win.keyboard.press('Meta+Backspace')
      await win.keyboard.type('echo ostia_$((40+2))_ok')
      await win.keyboard.press('Enter')
      await expect(rows).toContainText('ostia_42_ok')
      await expect(rows).not.toContainText('ostia_wrong_line')
      expect(app.windows()).toHaveLength(1)
    } finally {
      await app.close()
    }
  },
)
