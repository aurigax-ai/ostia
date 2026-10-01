import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
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

    await win.keyboard.type('echo pine_dir')
    await win.keyboard.press('Escape')
    await expect(input).toBeHidden()
    await win.keyboard.type('ect')
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

function fakeTools(): string {
  const bin = mkdtempSync(join(tmpdir(), 'pine-e2e-bin-'))
  for (const name of ['pinefake-tool', 'pinefake-alpha', 'pinefake-alps']) {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\necho ran_${name.replace('-', '_')}\n`)
    chmodSync(path, 0o755)
  }
  return bin
}

test('the input editor suggests from history, completes commands, highlights and edits with vim keys', async () => {
  test.setTimeout(120_000)
  const bin = fakeTools()
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
  })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    const input = win.getByRole('textbox', { name: 'Command input' })
    const ghost = win.locator('.input-editor-ghost')
    const highlight = win.getByTestId('input-editor-highlight')
    const count = async (text: string): Promise<number> =>
      (await rows.innerText()).split(text).length - 1
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.click()

    await win.keyboard.type('echo pine_suggest_one')
    await win.keyboard.press('Enter')
    await expect.poll(() => count('pine_suggest_one'), { timeout: 15_000 }).toBe(2)
    await expect(input).toBeFocused()
    await win.keyboard.type('echo pine_sug')
    await expect(ghost).toHaveText('gest_one')
    await win.keyboard.press('End')
    await expect(input).toHaveValue('echo pine_suggest_one')
    await expect(ghost).toHaveCount(0)
    await win.keyboard.press('Enter')
    await expect.poll(() => count('pine_suggest_one'), { timeout: 15_000 }).toBe(4)
    await expect(input).toBeFocused({ timeout: 15_000 })

    await win.keyboard.type('pinefake-to')
    await win.keyboard.press('Tab')
    await expect(input).toHaveValue('pinefake-tool ')
    await expect(highlight.locator('[data-token="command"]')).toHaveAttribute('data-known', 'true')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ran_pinefake_tool', { timeout: 15_000 })
    await expect(input).toBeFocused({ timeout: 15_000 })

    await win.keyboard.type('pinefake-al')
    await win.keyboard.press('Tab')
    const menu = win.getByRole('listbox', { name: 'Completions' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('option')).toHaveText(['pinefake-alps', 'pinefake-alpha'])
    await win.keyboard.press('ArrowDown')
    await win.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(input).toHaveValue('pinefake-alpha ')
    await win.keyboard.press('Control+c')

    await win.keyboard.type('pinefake-tool --verbose "a b" $HOME | pine_no_such_cmd > out # note')
    const token = (kind: string) => highlight.locator(`[data-token="${kind}"]`)
    await expect(token('command')).toHaveText(['pinefake-tool', 'pine_no_such_cmd'])
    await expect(token('command').first()).toHaveAttribute('data-known', 'true')
    await expect(token('command').last()).toHaveAttribute('data-known', 'false')
    await expect(token('flag')).toHaveText('--verbose')
    await expect(token('string')).toHaveText('"a b"')
    await expect(token('variable')).toHaveText('$HOME')
    await expect(token('operator')).toHaveText(['|', '>'])
    await expect(token('comment')).toHaveText('# note')
    const color = (el: ReturnType<typeof token>) =>
      el.evaluate((node) => getComputedStyle(node).color)
    const known = await color(token('command').first())
    expect(await color(token('command').last())).not.toBe(known)
    expect(await color(token('flag'))).not.toBe(await color(token('argument').first()))
    expect(await input.evaluate((node) => getComputedStyle(node).color)).toBe('rgba(0, 0, 0, 0)')
    await win.keyboard.press('Control+c')

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Terminal' }).click()
    await settings.getByRole('switch', { name: 'Vim keys in the input editor' }).click()
    await win.keyboard.press('Escape')
    await expect(settings).toBeHidden()
    await input.click()
    await expect(win.getByLabel('Vim mode')).toHaveText('INSERT')
    await win.keyboard.type('eecho pine_vim_bad')
    await win.keyboard.press('Escape')
    await expect(win.getByLabel('Vim mode')).toHaveText('NORMAL')
    await win.keyboard.type('0x$bcw')
    await expect(win.getByLabel('Vim mode')).toHaveText('INSERT')
    await win.keyboard.type('pine_vim_good')
    await win.keyboard.press('Escape')
    await expect(input).toHaveValue('echo pine_vim_good')
    await win.keyboard.press('Enter')
    await expect.poll(() => count('pine_vim_good'), { timeout: 15_000 }).toBe(2)
    expect(await count('pine_vim_bad')).toBe(0)
    await expect(input).toBeFocused()
    await expect(win.getByLabel('Vim mode')).toHaveText('INSERT')
  } finally {
    await app.close()
    rmSync(bin, { recursive: true, force: true })
  }
})

test('the input editor sits on the shell prompt line and takes what is aimed at the terminal', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, '.zshrc'),
    "PROMPT='pine_left❯ '\nRPROMPT='pine_right'\nbindkey '^R' history-incremental-search-backward\n",
  )
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
  })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, SHELL: '/usr/bin/zsh' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    const input = win.getByRole('textbox', { name: 'Command input' })
    const line = win.locator('.input-editor-line')
    await expect(input).toBeVisible({ timeout: 15_000 })
    const promptRow = rows.locator('div', { hasText: 'pine_left❯' }).last()
    const lineBox = await line.boundingBox()
    const rowBox = await promptRow.boundingBox()
    expect(lineBox && rowBox && Math.abs(lineBox.y - rowBox.y)).toBeLessThan(2)
    expect(lineBox && rowBox && lineBox.x).toBeGreaterThan(rowBox?.x ?? 0)
    await expect(rows).toContainText('pine_right')
    expect((await rows.innerText()).split('pine_left❯').length - 1).toBe(1)

    const top = await rows.boundingBox()
    await win.mouse.click((top?.x ?? 0) + 20, (top?.y ?? 0) + 5)
    await win.keyboard.type('echo pine_redirected')
    await expect(input).toHaveValue('echo pine_redirected')
    await expect(input).toBeFocused()
    await win.keyboard.press('Control+a')
    await win.keyboard.press('Control+k')
    await expect(input).toHaveValue('')
    await win.keyboard.press('Control+y')
    await expect(input).toHaveValue('echo pine_redirected')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_redirected\n', { timeout: 15_000 })
    await expect(input).toBeFocused({ timeout: 15_000 })

    await win.keyboard.type('echo pine_re')
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

test('Tab completes subcommands and options with descriptions from the built-in specs', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
  })
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const input = win.getByRole('textbox', { name: 'Command input' })
    const menu = win.getByRole('listbox', { name: 'Completions' })
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.click()
    await win.keyboard.type('git chec')
    await win.keyboard.press('Tab')
    await expect(input).toHaveValue('git checkout ', { timeout: 15_000 })
    await win.keyboard.type('--')
    await win.keyboard.press('Tab')
    await expect(menu).toBeVisible({ timeout: 15_000 })
    await expect(menu.getByRole('option', { name: /--force/ })).toContainText(/\S+\s+\S+/)
    await win.keyboard.press('Escape')
    await win.keyboard.press('Control+u')
    await win.keyboard.type('tar --exc')
    await win.keyboard.press('Tab')
    await expect(input).toHaveValue(/^tar --exclude/)
  } finally {
    await app.close()
  }
})

test('the completion menu stays open and narrows while typing, and a slash lists the folder', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
  })
  const launch = isolatedLaunch(dataHome)
  const goji = join(launch.home, 'Work', 'goji')
  for (const name of ['avail', 'avail-mock-feat', 'avail-mock-qa']) {
    mkdirSync(join(goji, name), { recursive: true })
  }
  mkdirSync(join(goji, 'avail', 'src'))
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const input = win.getByRole('textbox', { name: 'Command input' })
    const menu = win.getByRole('listbox', { name: 'Completions' })
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.click()

    await win.keyboard.type('cd ~/Work/goji/av')
    await win.keyboard.press('Tab')
    await expect(input).toHaveValue('cd ~/Work/goji/avail', { timeout: 15_000 })
    await expect(menu.getByRole('option')).toHaveText([
      'avail/',
      'avail-mock-feat/',
      'avail-mock-qa/',
    ])
    await win.keyboard.type('-m')
    await expect(menu.getByRole('option')).toHaveText(['avail-mock-feat/', 'avail-mock-qa/'])
    await win.keyboard.type('q')
    await expect(menu.getByRole('option')).toHaveText(['avail-mock-qa/'])
    await win.keyboard.press('Backspace')
    await expect(menu.getByRole('option')).toHaveText(['avail-mock-feat/', 'avail-mock-qa/'])
    await expect(menu.getByRole('option', { name: 'avail-mock-qa/' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await win.keyboard.press('Enter')
    await expect(input).toHaveValue('cd ~/Work/goji/avail-mock-qa/')
    await expect(menu).toBeHidden()
    await win.keyboard.press('Control+c')

    await win.keyboard.type('cd ~/Work/goji/av')
    await win.keyboard.press('Tab')
    await expect(menu).toBeVisible({ timeout: 15_000 })
    await win.keyboard.type('/')
    await expect(menu.getByRole('option')).toHaveText(['src/'], { timeout: 15_000 })
    await expect(input).toHaveValue('cd ~/Work/goji/avail/')
    await win.keyboard.press('Enter')
    await expect(input).toHaveValue('cd ~/Work/goji/avail/src/')
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows').first()).toContainText('goji/avail/src', {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})
