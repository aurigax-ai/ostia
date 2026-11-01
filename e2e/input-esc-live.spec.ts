import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

for (const shell of ['/bin/zsh', '/bin/bash']) {
  test(`Esc twice clears the prompt draft and paths open the file menu by themselves in ${shell}`, async () => {
    test.setTimeout(120_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, {
      ...CANVAS_RENDERER_SETTINGS,
      behavior: { ...CANVAS_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
    })
    const launch = isolatedLaunch(dataHome)
    mkdirSync(join(launch.home, 'ostia_live'), { recursive: true })
    writeFileSync(join(launch.home, 'ostia_live', 'alpha_one.txt'), '')
    writeFileSync(join(launch.home, 'ostia_live', 'alpha_two.txt'), '')
    const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: shell } })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      const rows = win.locator('.terminal-text').first()
      const input = win.getByRole('textbox', { name: 'Command input' })
      await expect(input).toBeVisible({ timeout: 15_000 })
      await input.click()

      await win.keyboard.type('echo ostia_esc_draft')
      await win.keyboard.press('Escape')
      await expect(win.getByText('Press Esc again to clear')).toBeVisible()
      await expect(input).toHaveValue('echo ostia_esc_draft')
      await win.keyboard.press('Escape')
      await expect(input).toHaveValue('')
      await expect(win.getByText('Draft cleared · Ctrl+Z to restore')).toBeVisible()
      await win.keyboard.press('Control+z')
      await expect(input).toHaveValue('echo ostia_esc_draft')
      await input.fill('')

      await win.keyboard.type('ls ostia_live/al')
      await expect(win.getByRole('option', { name: 'alpha_one.txt' })).toBeVisible()
      await expect(win.getByText('Tab to complete · Enter runs')).toBeVisible()
      await win.keyboard.press('ArrowDown')
      await win.keyboard.press('Tab')
      await expect(input).toHaveValue('ls ostia_live/alpha_two.txt ')
      await input.fill('')

      await win.keyboard.type('echo ostia_live/alpha_o')
      await expect(win.getByRole('option', { name: 'alpha_one.txt' })).toBeVisible()
      await win.keyboard.press('Enter')
      await expect(rows).toContainText('ostia_live/alpha_o\n', { timeout: 15_000 })
      await expect(win.getByRole('option', { name: 'alpha_one.txt' })).toBeHidden()
    } finally {
      await app.close()
    }
  })
}
