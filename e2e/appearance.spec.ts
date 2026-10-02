import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, openWorkspace } from './helpers'

async function launch(settings: object) {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, ...settings })
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
  return { app, win, dataHome }
}

async function openAppearance(win: Page) {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance' }).click()
  return settings
}

test('follow-system switches the theme live with the OS color scheme', async () => {
  const { app, win } = await launch({
    appearance: { followSystem: true, lightTheme: 'pine-light', darkTheme: 'dracula' },
  })
  try {
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'pine-light')
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
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'pine-light')
  } finally {
    await app.close()
  }
})

test('a custom accent color overrides the brand color on real elements', async () => {
  const { app, win } = await launch({})
  try {
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    const settings = await openAppearance(win)
    const followSystem = settings.getByRole('switch', { name: 'Match system appearance' })
    await followSystem.click()
    await expect(followSystem).toBeChecked()
    const before = await followSystem.evaluate((el) => getComputedStyle(el).backgroundColor)

    const hex = settings.getByRole('textbox', { name: 'Custom accent hex' })
    await hex.fill('#ff8800')

    await expect
      .poll(() => followSystem.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(255, 136, 0)')
    expect(before).not.toBe('rgb(255, 136, 0)')

    await hex.fill('nonsense')
    await expect(hex).toHaveAttribute('aria-invalid', 'true')
    await expect
      .poll(() => followSystem.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(255, 136, 0)')
  } finally {
    await app.close()
  }
})

test('zoom chords change the window zoom factor within 80 to 150 percent and persist it', async () => {
  const { app, win, dataHome } = await launch({})
  try {
    await openWorkspace(win)
    const factor = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
      )
    const colsWidth = () => win.evaluate(() => window.innerWidth)
    const baseWidth = await colsWidth()
    expect(await factor()).toBeCloseTo(1, 5)

    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+=')
    await expect.poll(factor).toBeCloseTo(1.1, 5)
    await expect.poll(colsWidth).toBeLessThan(baseWidth)

    await win.keyboard.press('Control+Shift+Minus')
    await win.keyboard.press('Control+Shift+Minus')
    await expect.poll(factor).toBeCloseTo(0.9, 5)

    for (let i = 0; i < 10; i++) await win.keyboard.press('Control+Shift+Minus')
    await expect.poll(factor).toBeCloseTo(0.8, 5)

    for (let i = 0; i < 10; i++) await win.keyboard.press('Control+=')
    await expect.poll(factor).toBeCloseTo(1.5, 5)

    await win.keyboard.press('Control+0')
    await expect.poll(factor).toBeCloseTo(1, 5)

    await win.keyboard.press('Control+=')
    const settingsFile = join(dataHome, 'userData', 'settings.json')
    await expect
      .poll(() => JSON.parse(readFileSync(settingsFile, 'utf8')).appearance?.zoom)
      .toBe(110)
  } finally {
    await app.close()
  }
})

test('a recorded notification runs the configured command with its placeholders filled', async () => {
  const dataHome = freshDataHome()
  const binDir = join(dataHome, 'bin')
  mkdirSync(binDir, { recursive: true })
  const script = join(binDir, 'on-notify.sh')
  const out = join(dataHome, 'notified.txt')
  writeFileSync(script, `#!/bin/sh\nprintf '%s|%s|%s' "$1" "$2" "$3" > "${out}"\n`)
  chmodSync(script, 0o755)
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    notifications: { desktop: false, command: `${script} {title} "{body}" {pane}` },
  })
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.evaluate(() =>
      window.pine.notifications.post({
        paneId: 'pane-x',
        title: 'Build',
        body: 'all; green',
        desktop: false,
      }),
    )

    await expect.poll(() => existsSync(out), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => readFileSync(out, 'utf8')).toBe('Build|all; green|pane-x')
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
      const path = await window.pine.settings.path()
      const current = JSON.parse((await window.pine.fs.read(path)) ?? '{}')
      current.appearance = { ...current.appearance, theme: 'pine-light', accent: '#ff8800' }
      await window.pine.fs.write(path, JSON.stringify(current, null, 2))
    })

    await expect(win.locator('html')).toHaveAttribute('data-theme', 'pine-light')
    await expect(hex).toHaveValue('#ff8800')
  } finally {
    await app.close()
  }
})
