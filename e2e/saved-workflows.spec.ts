import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

const GREET = `name: Greet someone
command: echo pine_wf_{{who}}_$((20+1))
description: Says hello
tags: [demo]
arguments:
  - name: who
    description: Who to greet
    default_value: world
`

function seedWorkflow(dataHome: string): string {
  const dir = join(dataHome, 'config', 'pine', 'workflows')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'greet.yaml'), GREET)
  return dir
}

async function focusTerminal(win: Page): Promise<void> {
  await win.locator('.xterm').first().click()
  await expect
    .poll(() =>
      win.evaluate(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
      ),
    )
    .toBe(true)
}

async function pickGreet(win: Page, who: string): Promise<void> {
  await win.keyboard.press('Control+Shift+S')
  const search = win.getByPlaceholder('Search workflows by name, tag or command…')
  await expect(search).toBeVisible({ timeout: 5_000 })
  await search.fill('demo')
  await win.getByRole('option', { name: /Greet someone/ }).click()
  const arg = win.getByLabel('who', { exact: true })
  await expect(arg).toBeFocused()
  await expect(arg).toHaveValue('world')
  await expect(win.getByLabel('Command', { exact: true })).toContainText('echo pine_wf_world_')
  await arg.fill(who)
  await win.keyboard.press('Enter')
  await expect(arg).toHaveCount(0)
}

test('workflows: fill arguments, insert at the prompt without running, save a block as one', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const workflowsDir = seedWorkflow(dataHome)
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const rows = win.locator('.xterm-rows').first()
    await openWorkspace(win)
    await focusTerminal(win)

    await pickGreet(win, 'tester')
    await expect(rows).toContainText('echo pine_wf_tester_$((20+1))', { timeout: 10_000 })
    await expect(rows).not.toContainText('pine_wf_tester_21')
    await expect(win.locator('.block-gutter')).toHaveCount(0)

    await focusTerminal(win)
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_wf_tester_21', { timeout: 15_000 })

    const gutter = win.locator('.block-gutter').first()
    await expect(gutter).toBeVisible({ timeout: 10_000 })
    await gutter.click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Save as workflow…' }).click()
    const name = win.getByLabel('Name', { exact: true })
    await expect(name).toHaveValue('echo pine_wf_tester_$((20+1))')
    await name.fill('Greet again')
    await win.getByLabel('Command', { exact: true }).fill('echo again_{{name}}')
    await win.getByLabel('name Default value').fill('pine')
    await win.getByRole('button', { name: 'Save' }).click()
    await expect(name).toHaveCount(0)

    expect(readdirSync(workflowsDir).sort()).toEqual(['greet-again.yaml', 'greet.yaml'])
    expect(readFileSync(join(workflowsDir, 'greet-again.yaml'), 'utf8')).toBe(
      'name: Greet again\ncommand: echo again_{{name}}\narguments:\n  - name: name\n    default_value: pine\n',
    )

    await focusTerminal(win)
    await win.keyboard.press('Control+Shift+S')
    await expect(win.getByRole('option', { name: /Greet again/ })).toBeVisible({ timeout: 5_000 })
  } finally {
    await app.close()
  }
})

test('workflows: fill the input editor when it is shown', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
  })
  seedWorkflow(dataHome)
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const editor = win.getByRole('textbox', { name: 'Command input' })
    await expect(editor).toBeVisible({ timeout: 15_000 })
    await editor.click()

    await pickGreet(win, 'editor')
    await expect(editor).toHaveValue('echo pine_wf_editor_$((20+1))')
    await expect(win.locator('.block-gutter')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
