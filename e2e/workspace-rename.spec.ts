import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { newTerminalWorkspace, openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

function frames(win: Page): Promise<void> {
  return win.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function runFromPalette(win: Page, title: string, id: string): Promise<void> {
  await win.keyboard.press(chords.palette)
  const palette = win.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill(title)
  const meta = win.locator('[data-slot="palette-meta"]', { hasText: new RegExp(`^${id}$`) })
  await palette.getByRole('option').filter({ has: meta }).click()
  await expect(palette).toBeHidden()
}

async function typeIntoEditor(win: Page, label: string, text: string): Promise<void> {
  const input = win.getByRole('textbox', { name: label })
  await expect(input).toBeVisible()
  await frames(win)
  await expect(input).toBeFocused()
  await input.fill(text)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

const rowTitles = (win: Page) => win.locator('.rail-row .tab-title')

test('Rename Workspace from the palette focuses the rail editor and keeps the typed name', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.xterm').first().click()

    await runFromPalette(win, 'Rename Workspace', 'workspace.rename')
    await typeIntoEditor(win, 'Workspace name', 'renamed-from-palette')
    await expect(rowTitles(win).first()).toHaveText('renamed-from-palette')

    await runFromPalette(win, 'Describe Workspace', 'workspace.describe')
    await typeIntoEditor(win, 'Workspace description', 'notes from palette')
    await expect(rowTitles(win).first()).toHaveText('renamed-from-palette')
  } finally {
    await app.close()
  }
})

test('Rename Workspace from the palette opens a collapsed group and renames its member and the group', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await newTerminalWorkspace(win)
    await expect(win.locator('.rail-row')).toHaveCount(2)

    await win.locator('.rail-tab-main').nth(1).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Move to new group' }).click()
    const groupName = win.getByRole('textbox', { name: 'Group name' })
    await groupName.fill('build')
    await groupName.press('Enter')
    const toggle = win.locator('.rail-group-head').getByRole('button', { name: /build/ })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const members = win.locator('.rail-group-members .rail-row')
    await expect(members).toHaveCount(0)

    await runFromPalette(win, 'Rename Workspace', 'workspace.rename')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await typeIntoEditor(win, 'Workspace name', 'grouped-member')
    await expect(members).toHaveCount(1)
    await expect(members.first().locator('.tab-title')).toHaveText('grouped-member')

    await runFromPalette(win, 'Rename Workspace Group', 'workspace.renameGroup')
    await typeIntoEditor(win, 'Group name', 'release')
    await expect(win.locator('.rail-group-name')).toHaveText('release')
  } finally {
    await app.close()
  }
})
