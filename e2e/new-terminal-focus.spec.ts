import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, emptyState, emptyWorkspace } from './helpers'

async function typesIntoNewest(win: Page, count: number, marker: string): Promise<void> {
  await expect(win.locator('.xterm:visible')).toHaveCount(count, { timeout: 15_000 })
  const rows = win.locator('.xterm:visible .xterm-rows').last()
  await expect(rows).toContainText(PROMPT, { timeout: 15_000 })
  await win.keyboard.type(`echo ${marker}`)
  await win.keyboard.press('Enter')
  await expect(rows).toContainText(`${marker}\n`.trim(), { timeout: 15_000 })
}

test('a terminal the human creates takes the keyboard without a click', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS })
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    await win
      .locator('.topbar')
      .getByRole('button', { name: 'More ways to start a workspace' })
      .click()
    await win.getByRole('menuitem', { name: 'New scratch workspace' }).click()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await typesIntoNewest(win, 1, 'first_focus_ok')

    await win.getByRole('button', { name: 'Split right' }).first().click()
    await typesIntoNewest(win, 2, 'split_focus_ok')

    await win.getByRole('button', { name: 'New terminal tab' }).last().click()
    await typesIntoNewest(win, 2, 'tab_focus_ok')
  } finally {
    await app.close()
  }
})
