import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, openWorkspace } from './helpers'

async function launch(settings: object) {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, ...settings })
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
  return { app, win }
}

const background = (win: Page, selector: string) =>
  win
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor)

async function showUpdateNotice(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('app:update-available', {
      version: '9.9.9',
      builtAt: '2026-09-30T00:00:00.000Z',
    })
  })
}

async function requestApproval(win: Page) {
  await win.locator('.xterm').first().click()
  await win.keyboard.type('ostia settings set sidebar.showSSH false')
  await win.keyboard.press('Enter')
  const card = win.getByRole('region', { name: 'Agent permission request' })
  await expect(card).toBeVisible({ timeout: 20_000 })
  return card
}

test('an unlinked terminal theme changes the terminal colors while the ostia theme stays', async () => {
  const { app, win } = await launch({})
  try {
    await openWorkspace(win)
    const bodyBefore = await background(win, 'body')
    await expect.poll(() => background(win, '.xterm-host')).toBe('rgb(29, 32, 34)')

    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
    const settings = win.getByRole('region', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Appearance' }).click()
    await settings.getByRole('switch', { name: 'Terminal colors: Match Ostia theme' }).click()
    const picker = settings.getByRole('combobox', { name: 'Terminal colors' })
    await picker.fill('mocha')
    await win.getByRole('option', { name: /Catppuccin Mocha/ }).click()
    await expect(picker).toHaveValue('Catppuccin Mocha')

    const preview = settings.getByTestId('theme-preview')
    await expect(preview).toHaveAccessibleName(
      'Preview: Adeberry Ostia theme, Catppuccin Mocha terminal, Adeberry editor',
    )
    await preview.screenshot({ path: test.info().outputPath('theme-preview.png') })
    await picker.click()
    await picker.fill('')
    await win.screenshot({
      path: test.info().outputPath('scheme-picker.png'),
      animations: 'disabled',
    })
    await win.keyboard.press('Escape')
    await win.screenshot({ path: test.info().outputPath('appearance.png') })

    await expect(win.locator('html')).toHaveAttribute('data-theme', 'adeberry')
    expect(await background(win, 'body')).toBe(bodyBefore)
    await expect.poll(() => background(win, '.xterm-host')).toBe('rgb(30, 30, 46)')
  } finally {
    await app.close()
  }
})

for (const [theme, expected] of [
  ['adeberry', { fill: 'rgb(242, 179, 71)', ink: 'rgb(29, 32, 34)' }],
  ['ostia-light', { fill: null, ink: 'rgb(246, 247, 249)' }],
] as const) {
  test(`a custom accent drives buttons, tab underline and working dot on ${theme}`, async () => {
    const { app, win } = await launch({ appearance: { theme, accent: '#f2b347' } })
    try {
      await openWorkspace(win)
      const brand = await win.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim(),
      )
      const fill =
        expected.fill ??
        (await win.evaluate((hex) => {
          const probe = document.createElement('span')
          probe.style.color = hex
          document.body.append(probe)
          const rgb = getComputedStyle(probe).color
          probe.remove()
          return rgb
        }, brand))

      await showUpdateNotice(app)
      const restart = win.getByRole('button', { name: 'Restart to update' })
      await expect(restart).toBeVisible()
      await expect
        .poll(() => restart.evaluate((el) => getComputedStyle(el).backgroundColor))
        .toBe(fill)
      expect(await restart.evaluate((el) => getComputedStyle(el).color)).toBe(expected.ink)

      const card = await requestApproval(win)
      const allow = card.getByRole('button', { name: 'Allow once' })
      expect(await allow.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(fill)
      expect(await allow.evaluate((el) => getComputedStyle(el).color)).toBe(expected.ink)

      const tab = win.locator('.pane.active .pane-tab.selected').first()
      if (await tab.count()) {
        expect(await tab.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(fill)
      }
      const working = win.locator('.dot.working').first()
      if (await working.count()) {
        expect(await working.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(fill)
      }

      await win.screenshot({ path: test.info().outputPath(`accent-${theme}.png`) })
      await card.getByRole('button', { name: 'Deny' }).click()
    } finally {
      await app.close()
    }
  })
}
