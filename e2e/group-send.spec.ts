import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, isolatedHome, startFakeAgent } from './fakeAgent'
import { PROMPT, emptyWorkspace, openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const visibleRows = (win: Page) => win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
const railRow = (win: Page, index: number) => win.locator('.rail-tab-main').nth(index)

const groupHeads = (win: Page) => win.locator('.rail-group-head')
const groupMembers = (win: Page) => win.locator('.rail-group-members .rail-row')

async function moveToNewGroup(win: Page, index: number, groups: number): Promise<void> {
  await railRow(win, index).click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Move to new group' }).click()
  await expect(groupHeads(win)).toHaveCount(groups)
  await railRow(win, 1).click()
  await expect(win.getByRole('textbox', { name: 'Group name' })).toHaveCount(0)
}

async function openSendPathMenu(win: Page, file: string): Promise<void> {
  await win.locator('.file-tree').getByRole('button', { name: file, exact: true }).click({
    button: 'right',
  })
  await win.getByRole('menuitem', { name: 'Send path to agent' }).click()
}

test('a file path goes to an agent in another workspace of the sidebar group once the human grouped them', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const home = isolatedHome(dataHome)
  writeFileSync(join(home, 'notes.md'), '# notes\n')
  const bin = fakeAgentBin(dataHome)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await startFakeAgent(win)

    await win.locator('.topbar').getByRole('button', { name: 'New workspace' }).click()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.rail-row')).toHaveCount(2)
    await expect(visibleRows(win).last()).toContainText(PROMPT, { timeout: 15_000 })

    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await openSendPathMenu(win, 'notes.md')
    await expect(
      win.getByRole('menuitem', { name: 'No agent is running in this workspace.' }),
    ).toBeVisible()
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')

    await moveToNewGroup(win, 0, 1)
    await expect(groupMembers(win)).toHaveCount(1)
    await win.locator('.pane-slot:not([data-hidden]) .xterm').last().click()
    await win.keyboard.type('ostia workspace group home; echo group-exit-$?')
    await win.keyboard.press('Enter')
    await expect(visibleRows(win).last()).toContainText('group-exit-0', { timeout: 15_000 })
    await expect(groupMembers(win)).toHaveCount(2)

    await openSendPathMenu(win, 'notes.md')
    await expect(
      win.getByRole('menuitem', { name: 'No agent is running in this workspace.' }),
    ).toBeVisible()
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')

    await moveToNewGroup(win, 1, 2)
    await railRow(win, 0).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Move to group' }).click()
    await win.getByRole('menuitem', { name: 'home', exact: true }).click()
    await expect(groupHeads(win)).toHaveCount(1)
    await expect(groupMembers(win)).toHaveCount(2)

    await openSendPathMenu(win, 'notes.md')
    await win.getByRole('menuitem', { name: /^Claude Code \(.+\)$/ }).click()

    await railRow(win, 1).click()
    await expect(visibleRows(win).first()).toContainText(/fake-agent-ready.*@\S*notes\.md/, {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})
