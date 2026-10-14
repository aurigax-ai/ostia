import { isolatedLaunch } from './dataHome'
import { openWorkspace, typeLine } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

function markTerminals(win: Page): Promise<number> {
  return win.evaluate(() => {
    const terms = [...document.querySelectorAll<HTMLElement>('.xterm')]
    for (const term of terms) term.dataset.moveMark = 'kept'
    return terms.length
  })
}

function markedTerminals(win: Page): Promise<number> {
  return win.evaluate(() => document.querySelectorAll('.xterm[data-move-mark="kept"]').length)
}

test('ostia pane move --tab moves running panes into a split tab and back out', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const strip = win.getByRole('tablist')
    const tabs = strip.getByRole('tab')
    const caller = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()

    await typeLine(win, 'ostia process run "echo one-$((40+1)); sleep 300" --name w1')
    await typeLine(win, 'ostia process run "echo two-$((40+2)); sleep 300" --name w2')
    await expect(tabs).toHaveCount(3, { timeout: 15_000 })
    await expect(caller).toContainText('"name":"w2"', { timeout: 15_000 })
    expect(await markTerminals(win)).toBe(3)

    await typeLine(win, 'clear; ostia pane move w1 w2 --tab workers')
    const pill = strip.locator('.pane-split-tab')
    await expect(pill).toHaveCount(1, { timeout: 15_000 })
    await expect(pill).toHaveAttribute('aria-label', /^Split tab workers, side by side: /)
    await expect(pill.locator('.split-tab-segment')).toHaveCount(2)
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')

    await typeLine(win, 'clear; ostia pane move w1 --tab workers --json')
    await expect(caller).toContainText('{"ok":true,"moved":[]}', { timeout: 15_000 })

    await pill.locator('.split-tab-segment-main').first().click()
    await expect(win.locator('.pane-cell .xterm-rows').nth(0)).toContainText('one-41')
    await expect(win.locator('.pane-cell .xterm-rows').nth(1)).toContainText('two-42')
    expect(await markedTerminals(win)).toBe(3)

    await tabs.nth(0).click()
    await win.locator('.xterm:visible').click()
    await typeLine(win, 'clear; ostia pane move w2 --tab new && ostia process ls')
    await expect(strip.locator('.pane-split-tab')).toHaveCount(0, { timeout: 15_000 })
    await expect(tabs).toHaveCount(3)
    await expect(caller).toContainText(/w1\s+running/, { timeout: 15_000 })
    await expect(caller).toContainText(/w2\s+running/)
    expect(await markedTerminals(win)).toBe(3)
  } finally {
    await app.close()
  }
})
