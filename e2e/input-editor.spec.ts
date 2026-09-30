import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

async function switchToEditorMode(win: Page): Promise<void> {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Terminal' }).click()
  await settings.getByRole('combobox', { name: 'Input mode' }).click()
  await win.getByRole('option', { name: 'Input editor' }).click()
  await expect(settings.getByRole('combobox', { name: 'Input mode' })).toContainText('Input editor')
  await win.keyboard.press('Escape')
}

test('the input editor runs commands, walks history and steps aside for interactive programs', async () => {
  test.setTimeout(90_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    const input = win.getByRole('textbox', { name: 'Command input' })
    const promptLines = async (): Promise<number> =>
      (await rows.innerText()).split('\n').filter((l) => l.includes('❯')).length
    await win.waitForTimeout(1_500)
    await expect.poll(promptLines).toBe(1)
    await expect(input).toBeHidden()

    await switchToEditorMode(win)
    await expect(input).toBeVisible()
    await win.waitForTimeout(2_000)
    await expect
      .poll(promptLines, { message: 'the shrink at the idle prompt must not duplicate it' })
      .toBe(1)

    await input.click()
    await win.keyboard.type('echo pine_editor_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_editor_42', { timeout: 15_000 })
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('')

    await win.keyboard.type('echo pine_ml_1')
    await win.keyboard.press('Shift+Enter')
    await win.keyboard.type('echo pine_ml_2')
    await expect(input).toHaveValue('echo pine_ml_1\necho pine_ml_2')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_ml_2', { timeout: 15_000 })
    await expect(input).toBeFocused()

    await win.keyboard.press('ArrowUp')
    await expect(input).toHaveValue('echo pine_ml_1\necho pine_ml_2')
    await win.keyboard.press('Control+c')
    await expect(input).toHaveValue('')
    await win.keyboard.press('ArrowUp')
    await expect(input).toHaveValue('echo pine_ml_1\necho pine_ml_2')
    await win.keyboard.press('ArrowUp')
    await expect(input).toHaveValue('echo pine_editor_$((40+2))')
    await win.keyboard.press('Control+c')

    await win.keyboard.type('cat')
    await win.keyboard.press('Enter')
    await expect(input).toBeHidden()
    await win.keyboard.type('pine_cat_line')
    await win.keyboard.press('Enter')
    await expect
      .poll(async () => (await rows.innerText()).split('pine_cat_line').length - 1, {
        timeout: 15_000,
      })
      .toBe(2)
    await win.keyboard.press('Control+d')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await expect(input).toBeFocused()

    await win.keyboard.press('Escape')
    await expect(input).not.toBeFocused()
    await win.keyboard.type('echo pine_direct')
    await expect(input).toBeHidden()
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_direct', { timeout: 15_000 })
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.click()

    await win.keyboard.type('echo pine_after_cat')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_after_cat', { timeout: 15_000 })
    await win.waitForTimeout(1_500)
    const settled = await promptLines()
    await win.waitForTimeout(2_000)
    expect(await promptLines()).toBe(settled)
  } finally {
    await app.close()
  }
})
