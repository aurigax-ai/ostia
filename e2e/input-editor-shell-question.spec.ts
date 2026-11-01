import { isolatedLaunch } from './dataHome'
import { expectHeld, openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('the input editor stays hidden while zsh asks a question and yields to typeahead on the next prompt', async () => {
  test.setTimeout(90_000)
  const launch = isolatedLaunch()
  const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: '/bin/zsh' } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.terminal-text').first()
    const input = win.getByRole('textbox', { name: 'Command input' })
    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Terminal' }).click()
    await settings.getByRole('combobox', { name: 'Input mode' }).click()
    await win.getByRole('option', { name: 'Input editor' }).click()
    await win.keyboard.press('Escape')
    await expect(input).toBeVisible()
    await input.click()

    await win.keyboard.type('setopt correct')
    await win.keyboard.press('Enter')
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('')

    await win.keyboard.type('echo ostia_one')
    await win.keyboard.press('Shift+Enter')
    await win.keyboard.type("What it's")
    await win.keyboard.press('Enter')
    await expect(rows).toContainText("correct 'What' to 'halt'", { timeout: 15_000 })
    await expect(input).toBeHidden()

    await win.keyboard.type('n')
    await expect(rows).toContainText('quote>', { timeout: 15_000 })
    await expect(input).toBeHidden()

    await win.keyboard.type("'; sleep 3")
    await win.keyboard.press('Enter')
    await win.keyboard.type('late_typeahead')
    const promptLines = async (): Promise<number> =>
      (await rows.innerText()).split('\n').filter((l) => l.includes('❯')).length
    await expect.poll(promptLines, { timeout: 15_000 }).toBe(3)
    await expect(input).toBeHidden({ timeout: 5_000 })
    await expectHeld(
      async () => await input.isVisible(),
      false,
      1_500,
      'the editor must not sit beside the shell line',
    )

    await win.keyboard.press('Enter')
    await expect(rows).toContainText('command not found: late_typeahead', { timeout: 15_000 })
    await expect(input).toBeVisible({ timeout: 15_000 })
    await expect(input).toHaveValue('')
    await input.click()
    await win.keyboard.type('echo ostia_after_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_after_42', { timeout: 15_000 })
    await expect(input).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the input editor keeps its draft and types nothing when a background job ends', async () => {
  test.setTimeout(90_000)
  const launch = isolatedLaunch()
  const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: '/bin/zsh' } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.terminal-text').first()
    const input = win.getByRole('textbox', { name: 'Command input' })
    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Terminal' }).click()
    await settings.getByRole('combobox', { name: 'Input mode' }).click()
    await win.getByRole('option', { name: 'Input editor' }).click()
    await win.keyboard.press('Escape')
    await expect(input).toBeVisible()
    await input.click()

    await win.keyboard.type('sleep 2 &')
    await win.keyboard.press('Enter')
    await expect(input).toBeVisible()
    await win.keyboard.type('echo ostia_draft_$((40+2))')
    await expect(rows).toContainText('done', { timeout: 15_000 })
    await expectHeld(
      async () => [await input.isVisible(), await input.inputValue()],
      [true, 'echo ostia_draft_$((40+2))'],
      1_500,
      'a background job notice must not move the draft into the shell line',
    )

    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_draft_42', { timeout: 15_000 })
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('')
  } finally {
    await app.close()
  }
})
