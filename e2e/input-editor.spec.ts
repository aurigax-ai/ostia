import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

async function switchToEditorMode(win: Page): Promise<void> {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Terminal' }).click()
  await settings.getByRole('combobox', { name: 'Input mode' }).click()
  await win.getByRole('option', { name: 'Input editor' }).click()
  await expect(settings.getByRole('combobox', { name: 'Input mode' })).toContainText('Input editor')
  await win.keyboard.press('Escape')
}

for (const shell of ['/bin/zsh', '/bin/bash']) {
  const bash32 = process.platform === 'darwin' && shell === '/bin/bash'
  const note = bash32
    ? ' (not on macOS: bash 3.2 has no bracketed paste, so history keeps one line)'
    : ''
  test(`the input editor runs a multi-line command and recalls it whole in ${shell}${note}`, async () => {
    test.skip(bash32)
    test.setTimeout(60_000)
    const launch = isolatedLaunch()
    const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: shell } })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      const rows = win.locator('.xterm-rows').first()
      const input = win.getByRole('textbox', { name: 'Command input' })
      await switchToEditorMode(win)
      await expect(input).toBeVisible()
      await input.click()

      await win.keyboard.type('echo ostia_ml_1')
      await win.keyboard.press('Shift+Enter')
      await win.keyboard.type('echo ostia_ml_2')
      await expect(input).toHaveValue('echo ostia_ml_1\necho ostia_ml_2')
      await win.keyboard.press('Enter')
      await expect(rows).toContainText('ostia_ml_2', { timeout: 15_000 })
      await expect(input).toBeFocused()

      await win.keyboard.press('ArrowUp')
      await expect(input).toHaveValue('echo ostia_ml_1\necho ostia_ml_2')
      await win.keyboard.press('Control+c')
      await expect(input).toHaveValue('')
      await win.keyboard.press('ArrowUp')
      await expect(input).toHaveValue('echo ostia_ml_1\necho ostia_ml_2')
    } finally {
      await app.close()
    }
  })
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
    await win.keyboard.type('echo ostia_editor_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_editor_42', { timeout: 15_000 })
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('')

    await win.keyboard.press('ArrowUp')
    await expect(input).toHaveValue('echo ostia_editor_$((40+2))')
    await win.keyboard.press('Control+c')
    await expect(input).toHaveValue('')

    await win.keyboard.type('cat')
    await win.keyboard.press('Enter')
    await expect(input).toBeHidden()
    await win.keyboard.type('ostia_cat_line')
    await win.keyboard.press('Enter')
    await expect
      .poll(async () => (await rows.innerText()).split('ostia_cat_line').length - 1, {
        timeout: 15_000,
      })
      .toBe(2)
    await win.keyboard.press('Control+d')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await expect(input).toBeFocused()

    await win.keyboard.type('echo ostia_dir')
    await win.keyboard.press('Escape')
    await expect(input).toBeHidden()
    await win.keyboard.type('ect')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_direct', { timeout: 15_000 })
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.click()

    await win.keyboard.type('echo ostia_after_cat')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_after_cat', { timeout: 15_000 })
    await win.waitForTimeout(1_500)
    const settled = await promptLines()
    await win.waitForTimeout(2_000)
    expect(await promptLines()).toBe(settled)
  } finally {
    await app.close()
  }
})

test('the input editor sits on the shell prompt line and takes what is aimed at the terminal', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, '.zshrc'),
    "PROMPT='ostia_left❯ '\nRPROMPT='ostia_right'\nbindkey '^R' history-incremental-search-backward\n",
  )
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
  })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, SHELL: '/bin/zsh' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    const input = win.getByRole('textbox', { name: 'Command input' })
    const line = win.locator('.input-editor-line')
    await expect(input).toBeVisible({ timeout: 15_000 })
    const promptRow = rows.locator('div', { hasText: 'ostia_left❯' }).last()
    const lineBox = await line.boundingBox()
    const rowBox = await promptRow.boundingBox()
    expect(lineBox && rowBox && Math.abs(lineBox.y - rowBox.y)).toBeLessThan(2)
    expect(lineBox && rowBox && lineBox.x).toBeGreaterThan(rowBox?.x ?? 0)
    await expect(rows).toContainText('ostia_right')
    expect((await rows.innerText()).split('ostia_left❯').length - 1).toBe(1)

    const top = await rows.boundingBox()
    await win.mouse.click((top?.x ?? 0) + 20, (top?.y ?? 0) + 5)
    await win.keyboard.type('echo ostia_redirected')
    await expect(input).toHaveValue('echo ostia_redirected')
    await expect(input).toBeFocused()
    await win.keyboard.press('Control+a')
    await win.keyboard.press('Control+k')
    await expect(input).toHaveValue('')
    await win.keyboard.press('Control+y')
    await expect(input).toHaveValue('echo ostia_redirected')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_redirected\n', { timeout: 15_000 })
    await expect(input).toBeFocused({ timeout: 15_000 })

    await win.keyboard.type('echo ostia_re')
    await win.keyboard.press('Control+r')
    await expect(input).toBeHidden()
    await expect(rows).toContainText('bck-i-search', { timeout: 15_000 })
    await win.keyboard.press('Control+g')
    await win.keyboard.press('Enter')
    await expect(input).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})
