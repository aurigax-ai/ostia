import { freshDataHome } from './dataHome'
import { launchWindow, openWorkspace, quitApp, typeLine } from './helpers'
import { expect, type Locator, type Page, test } from './test'

function rows(win: Page, index: number): Locator {
  return win.locator('.terminal-text').nth(index)
}

function shownRows(win: Page): Locator {
  return win.locator('.pane-slot:not([data-hidden]) .terminal-text')
}

function callerHasFocus(win: Page): Promise<boolean> {
  return win.evaluate(() => {
    const active = document.activeElement
    return (
      active?.matches('.ghostty-host, .ghostty-host *') === true &&
      active.closest('.ghostty-host') === document.querySelectorAll('.ghostty-host')[0]
    )
  })
}

test('ostia process run shows the command in a terminal tab the human can watch', async () => {
  const dataHome = freshDataHome()
  let { app, win } = await launchWindow(dataHome)
  try {
    await openWorkspace(win)
    const tabs = win.getByRole('tablist').getByRole('tab')
    await win.locator('.ghostty-host').first().click()

    await typeLine(
      win,
      "ostia process run \"printf '\\033]0;hijack\\007'; echo hello-from-$((40+2)) 'two  words' && sleep 30\" --name demo",
    )

    await expect(tabs).toHaveCount(2, { timeout: 15_000 })
    await expect(tabs.nth(1)).toContainText('demo')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false')
    await expect(tabs.nth(1)).toContainText('demo')
    await expect(tabs.nth(1)).not.toContainText('hijack')
    await expect(rows(win, 0)).toContainText('"name":"demo"')
    await expect(rows(win, 0)).not.toContainText('hello-from-42')
    expect(await callerHasFocus(win)).toBe(true)

    await tabs.nth(1).click()
    await expect(win.locator('.ghostty-host').nth(1)).toBeVisible()
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(shownRows(win)).toContainText('hello-from-42 two  words', { timeout: 20_000 })

    await quitApp(app)
    ;({ app, win } = await launchWindow(dataHome))
    const restored = win.getByRole('tablist').getByRole('tab')
    await expect(restored).toHaveCount(2, { timeout: 20_000 })
    await expect(restored.nth(1)).toContainText('demo')
    await restored.nth(0).click()
    await expect(rows(win, 0)).toContainText('workspace restored', { timeout: 20_000 })
    await win.locator('.ghostty-host').first().click()
    await typeLine(win, 'ostia process list')
    await expect(rows(win, 0)).toContainText('(no tracked processes)', { timeout: 15_000 })
  } finally {
    await quitApp(app)
  }
})
