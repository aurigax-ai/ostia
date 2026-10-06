import { _electron as electron, expect, test } from '@playwright/test'
import { chords } from './chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, openWorkspace } from './helpers'

for (const theme of ['adeberry', 'ostia-light']) {
  test(`palette screenshots on ${theme}`, async () => {
    const dataHome = freshDataHome()
    seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, appearance: { theme } })
    const app = await electron.launch(isolatedLaunch(dataHome))
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
    try {
      await openWorkspace(win)
      await win.keyboard.press(chords.palette)
      const palette = win.getByRole('dialog', { name: 'Command palette' })
      await expect(palette).toBeVisible()
      await expect(palette.getByRole('option').first()).toBeVisible()
      await win.waitForTimeout(400)
      await test.info().attach(`palette-${theme}-all`, {
        body: await palette.screenshot(),
        contentType: 'image/png',
      })
      await palette.getByRole('combobox').fill('pane')
      await expect(palette.getByRole('option').first()).toBeVisible()
      await win.waitForTimeout(400)
      await test.info().attach(`palette-${theme}-search`, {
        body: await palette.screenshot(),
        contentType: 'image/png',
      })
    } finally {
      await app.close()
    }
  })
}
