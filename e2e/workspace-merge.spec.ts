import { freshDataHome, isolatedLaunch } from './dataHome'
import { newTerminalWorkspace, openWorkspace, quitApp } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const shownTerminals = (win: Page) => win.locator('.pane-slot:not([data-hidden]) .xterm')

async function highestTick(win: Page): Promise<number> {
  const text = (
    await win.locator('.pane-slot:not([data-hidden]) .xterm-rows').allTextContents()
  ).join('\n')
  const ticks = [...text.matchAll(/tick-(\d+)/g)].map((m) => Number(m[1]))
  return ticks.length === 0 ? 0 : Math.max(...ticks)
}

test('merges a workspace into another one in the same folder after the human confirms', async () => {
  test.setTimeout(120_000)
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await newTerminalWorkspace(win)
    await expect(win.locator('.rail-row')).toHaveCount(2)

    await shownTerminals(win).last().click()
    await win.keyboard.type('for i in $(seq 1 600); do echo tick-$i; sleep 0.1; done')
    await win.keyboard.press('Enter')
    await expect.poll(() => highestTick(win), { timeout: 15_000 }).toBeGreaterThan(3)

    await shownTerminals(win)
      .last()
      .evaluate((el) => {
        el.setAttribute('data-merge-mark', 'source')
      })

    await win.locator('.rail-tab-main').nth(1).click({ button: 'right' })
    await win.getByRole('menuitem', { name: /^Merge into / }).click()

    const dialog = win.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(/Merge “.+” into “.+”\?/)
    await expect(dialog).toContainText('Terminals: 1')
    await expect(dialog).toContainText(/seq 1 600.* keeps running/)
    await expect(dialog.getByRole('button', { name: 'Merge' })).toBeFocused()
    await dialog.getByRole('button', { name: 'Merge' }).click()
    await expect(dialog).toBeHidden()

    await expect(win.locator('.rail-row')).toHaveCount(1)
    await expect(win.locator('.xterm')).toHaveCount(2)
    await expect(shownTerminals(win)).toHaveCount(2)
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm[data-merge-mark]')).toHaveCount(
      1,
    )

    const atMerge = await highestTick(win)
    await expect.poll(() => highestTick(win), { timeout: 15_000 }).toBeGreaterThan(atMerge + 5)
  } finally {
    await quitApp(app)
  }
})
