import { isolatedLaunch } from './dataHome'
import { newTerminalWorkspace, openWorkspace } from './helpers'
import { _electron as electron, expect, type Page, test } from './test'

function otherWorkspaceRow(win: Page) {
  return win.locator('.rail-row .rail-tab:not(.active) .rail-tab-main')
}

function shownRows(win: Page) {
  return win.locator('.workzone-workspace:not([data-hidden]) .terminal-text')
}

test('typing right after a click on a workspace row lands in its active terminal', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await newTerminalWorkspace(win)
    await expect(win.locator('.rail-row')).toHaveCount(2, { timeout: 15_000 })

    await otherWorkspaceRow(win).click()
    await win.keyboard.type('echo first_$((20+1))')
    await win.keyboard.press('Enter')
    await expect(shownRows(win)).toContainText('first_21', { timeout: 15_000 })

    await otherWorkspaceRow(win).click()
    await win.keyboard.type('echo second_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(shownRows(win)).toContainText('second_42', { timeout: 15_000 })
    await expect(shownRows(win)).not.toContainText('first_21')

    await otherWorkspaceRow(win).click()
    await expect(shownRows(win)).toContainText('first_21')
    await expect(shownRows(win)).not.toContainText('second_42')
  } finally {
    await app.close()
  }
})
