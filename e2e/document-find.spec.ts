import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('the find key finds in the code editor and in the Markdown preview', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'notes.md'), '# Needle\n\nOne needle, then another needle.\n')
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await win.locator('.file-tree').getByRole('button', { name: 'notes.md' }).click()

    const editor = win.locator('.editor-host .monaco-editor')
    await expect(editor).toBeVisible({ timeout: 15_000 })
    await editor.locator('.view-lines').click()
    await win.keyboard.press('Control+Shift+F')
    await expect(win.locator('.editor-host .find-widget.visible')).toBeVisible({ timeout: 5_000 })
    await win.keyboard.press('Escape')

    await win.getByRole('button', { name: 'Preview Markdown' }).click()
    const preview = win.locator('.markdown-preview')
    await expect(preview).toContainText('another needle')
    await preview.locator('p').click()
    await win.keyboard.press('Control+Shift+F')
    const box = win.getByRole('textbox', { name: 'Find in preview' })
    await expect(box).toBeFocused()
    await box.fill('needle')
    await expect(win.locator('.document-find')).toContainText('1/3')
    await win.keyboard.press('Enter')
    await expect(win.locator('.document-find')).toContainText('2/3')
    const painted = await win.evaluate(() => {
      const registry = (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights
      return registry.get('ostia-find')?.size ?? 0
    })
    expect(painted).toBe(3)
    await win.keyboard.press('Escape')
    await expect(box).toHaveCount(0)
  } finally {
    await app.close()
  }
})
