import { freshDataHome, isolatedLaunch } from './dataHome'
import { newTerminalWorkspace, openWorkspace, quitApp } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

interface Launched {
  app: ElectronApplication
  win: Page
}

async function launchApp(dataHome: string): Promise<Launched> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (err) {
    await app.close()
    throw err
  }
}

const groupHead = (win: Page) => win.locator('.rail-group-head')
const groupToggle = (win: Page) => groupHead(win).getByRole('button', { name: /build/ })
const memberRows = (win: Page) => win.locator('.rail-group-members .rail-row')
const ungroupedRows = (win: Page) => win.locator('.workspaces > .rail-row')

test('workspace groups: create, add, collapse with attention, restore, drag out', async () => {
  test.setTimeout(150_000)
  const dataHome = freshDataHome()

  const first = await launchApp(dataHome)
  try {
    const { win } = first
    await openWorkspace(win)
    await newTerminalWorkspace(win)
    await expect(win.locator('.rail-row')).toHaveCount(2)

    await win.locator('.rail-tab-main').nth(1).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Move to new group' }).click()
    const name = win.getByRole('textbox', { name: 'Group name' })
    await name.fill('build')
    await name.press('Enter')
    await expect(groupToggle(win)).toBeVisible()
    await expect(memberRows(win)).toHaveCount(1)

    await newTerminalWorkspace(win)
    await expect(memberRows(win)).toHaveCount(2)
    await expect(ungroupedRows(win)).toHaveCount(1)
    await expect(groupHead(win).getByLabel('Members: 2')).toHaveText('2')

    await win.locator('.pane-slot:not([data-hidden]) .xterm').last().click()
    await win.keyboard.type('sleep 2; false')
    await win.keyboard.press('Enter')
    await ungroupedRows(win).locator('.rail-tab-main').click()

    await groupToggle(win).click()
    await expect(groupToggle(win)).toHaveAttribute('aria-expanded', 'false')
    await expect(memberRows(win)).toHaveCount(0)
    await expect(groupHead(win).getByRole('img', { name: 'Error' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(groupHead(win).getByRole('img', { name: '1 unread' })).toBeVisible()
  } finally {
    await quitApp(first.app)
  }

  const second = await launchApp(dataHome)
  try {
    const { win } = second
    await expect(groupToggle(win)).toBeVisible({ timeout: 15_000 })
    await expect(groupToggle(win)).toHaveAttribute('aria-expanded', 'false')
    await expect(groupHead(win).getByLabel('Members: 2')).toHaveText('2')
    await expect(ungroupedRows(win)).toHaveCount(1)

    await groupToggle(win).click()
    await expect(memberRows(win)).toHaveCount(2)

    await memberRows(win)
      .last()
      .dragTo(ungroupedRows(win).first(), { targetPosition: { x: 40, y: 4 } })
    await expect(memberRows(win)).toHaveCount(1)
    await expect(ungroupedRows(win)).toHaveCount(2)
    await expect(groupHead(win).getByLabel('Members: 1')).toHaveText('1')
  } finally {
    await quitApp(second.app)
  }
})
