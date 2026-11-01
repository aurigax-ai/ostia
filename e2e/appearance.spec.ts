import { CANVAS_RENDERER_SETTINGS, freshDataHome, seedSettings } from './dataHome'
import { emptyState, launchWindow } from './helpers'
import { type Page, expect, test } from './test'

async function launch(settings: object) {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...CANVAS_RENDERER_SETTINGS, ...settings })
  const launched = await launchWindow(dataHome)
  await expect(emptyState(launched.win)).toBeVisible({ timeout: 15_000 })
  return launched
}

async function openAppearance(win: Page) {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance' }).click()
  return settings
}

test('follow-system switches the theme live with the OS color scheme', async () => {
  const { app, win } = await launch({
    appearance: { followSystem: true, lightTheme: 'ostia-light', darkTheme: 'dracula' },
  })
  try {
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'ostia-light')
    const lightBg = await win.evaluate(() => getComputedStyle(document.body).backgroundColor)

    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dracula')
    const darkBg = await win.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(darkBg).not.toBe(lightBg)

    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'ostia-light')
  } finally {
    await app.close()
  }
})

test('saving settings.json from the window applies it to that window and its Settings page', async () => {
  const { app, win } = await launch({ appearance: { followSystem: false, theme: 'dracula' } })
  try {
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dracula')
    const settings = await openAppearance(win)
    const hex = settings.getByRole('textbox', { name: 'Custom accent hex' })
    await expect(hex).toHaveValue('')

    await win.evaluate(async () => {
      const path = await window.ostia.settings.path()
      const res = await window.ostia.fs.read(path)
      const current = JSON.parse(res.ok ? res.text : '{}')
      current.appearance = { ...current.appearance, theme: 'ostia-light', accent: '#ff8800' }
      await window.ostia.fs.write(path, JSON.stringify(current, null, 2))
    })

    await expect(win.locator('html')).toHaveAttribute('data-theme', 'ostia-light')
    await expect(hex).toHaveValue('#ff8800')
  } finally {
    await app.close()
  }
})
