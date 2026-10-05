import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

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
    const strip = win.getByRole('tablist')
    const box = await strip.boundingBox()
    const lastTab = await strip.locator('.pane-tab').last().boundingBox()
    if (!lastTab || !box) throw new Error('tab strip is not laid out')
    await win.mouse.dblclick(lastTab.x + lastTab.width + 40, box.y + box.height / 2)
    const tabs = strip.getByRole('tab')
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
