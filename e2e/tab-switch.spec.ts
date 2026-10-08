import { chords, isMac } from './chords'
import { isolatedLaunch } from './dataHome'
import { addTab, openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const shownTerminalFocused = (win: Page) =>
  win.waitForFunction(() => {
    const el = document.activeElement
    if (!el?.classList.contains('xterm-helper-textarea')) return false
    const term = el.closest('.xterm')
    return term instanceof HTMLElement && term.offsetParent !== null
  })

test('Ctrl+Tab and Ctrl+Shift+Tab cycle the tabs of the focused pane', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await addTab(win)
    const tabs = win.getByRole('tablist').getByRole('tab')
    await expect(tabs).toHaveCount(2, { timeout: 15_000 })
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

    await win.locator('.xterm:visible').click()
    await shownTerminalFocused(win)
    await win.keyboard.press(chords.nextTab)
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await shownTerminalFocused(win)

    await win.keyboard.press(chords.nextTab)
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

    await win.keyboard.press(chords.previousTab)
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await shownTerminalFocused(win)
  } finally {
    await app.close()
  }
})

test('Ctrl+PageDown and Ctrl+PageUp cycle the tabs of the focused pane on Linux', async () => {
  test.skip(isMac, 'Ctrl+PageUp and Ctrl+PageDown are only bound on Linux')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await addTab(win)
    const tabs = win.getByRole('tablist').getByRole('tab')
    await expect(tabs).toHaveCount(2, { timeout: 15_000 })
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

    await win.locator('.xterm:visible').click()
    await shownTerminalFocused(win)
    await win.keyboard.press('Control+PageDown')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await shownTerminalFocused(win)

    await win.keyboard.press('Control+PageUp')
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await shownTerminalFocused(win)

    await win.keyboard.press(chords.nextTab)
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
  } finally {
    await app.close()
  }
})
