import { freshDataHome } from './dataHome'
import { launchWindow, newTerminalWorkspace, openWorkspace, PROMPT, quitApp } from './helpers'
import { expect, type Page, test } from './test'

const groupHead = (win: Page) => win.locator('.rail-group-head')
const groupToggle = (win: Page) => groupHead(win).getByRole('button', { name: /build/ })
const memberRows = (win: Page) => win.locator('.rail-group-members .rail-row')
const ungroupedRows = (win: Page) => win.locator('.workspaces > .rail-row')

test('workspace groups: a collapsed group shows a member’s failed command and comes back collapsed after a restart', async () => {
  test.setTimeout(150_000)
  const dataHome = freshDataHome()

  const first = await launchWindow(dataHome)
  try {
    const { win } = first
    await openWorkspace(win)
    await newTerminalWorkspace(win)
    await expect(win.locator('.rail-row')).toHaveCount(2)

    await win.locator('.rail-tab.active .rail-tab-main').click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Move to new group' }).click()
    const name = win.getByRole('textbox', { name: 'Group name' })
    await name.fill('build')
    await name.press('Enter')
    await expect(memberRows(win)).toHaveCount(1)
    await expect(win.locator('.pane-slot:not([data-hidden]) .terminal-text').last()).toContainText(
      PROMPT,
      { timeout: 15_000 },
    )

    await win.locator('.pane-slot:not([data-hidden]) .ghostty-host').last().click()
    await win.keyboard.type('sleep 2; false')
    await win.keyboard.press('Enter')
    await ungroupedRows(win).first().locator('.rail-tab-main').click()

    await groupToggle(win).click()
    await expect(groupToggle(win)).toHaveAttribute('aria-expanded', 'false')
    await expect(groupHead(win).getByRole('img', { name: '1 failed' })).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await quitApp(first.app)
  }

  const second = await launchWindow(dataHome)
  try {
    const { win } = second
    await expect(groupToggle(win)).toBeVisible({ timeout: 15_000 })
    await expect(groupToggle(win)).toHaveAttribute('aria-expanded', 'false')
    await expect(ungroupedRows(win)).toHaveCount(1)
  } finally {
    await quitApp(second.app)
  }
})
