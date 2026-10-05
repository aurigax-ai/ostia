import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { buildSync } from 'esbuild'
import { PRODUCT_NAME } from '../src/shared/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'

const fixture = join(__dirname, '..', 'test', 'fixtures', 'extensions-e2e', 'hello')

function installTranslatedExtension(configHome: string): void {
  const dir = join(configHome, PRODUCT_NAME, 'extensions', 'hello')
  mkdirSync(dir, { recursive: true })
  for (const file of ['ostia.json', 'panel.html', 'locales']) {
    cpSync(join(fixture, file), join(dir, file), { recursive: true })
  }
  buildSync({
    entryPoints: [join(fixture, 'main.js')],
    outfile: join(dir, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'warning',
  })
}

async function paletteOffers(win: Page, title: string): Promise<void> {
  await win.keyboard.press('Control+Shift+P')
  await win.locator('[data-slot="command-input"]').fill(title)
  await waitForPaletteSelection(win, title)
  await expect(win.getByRole('dialog').getByText(title, { exact: true })).toBeVisible()
}

test("an extension's own catalog translates its command, panel and settings row, and follows the language both ways", async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  installTranslatedExtension(launch.env.XDG_CONFIG_HOME)
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    const approval = win.getByRole('dialog').filter({ hasText: 'Hello' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await expect(approval).toBeHidden()
    await openWorkspace(win)

    await paletteOffers(win, 'Hello: Open Panel')
    await win.keyboard.press('Enter')
    const tabTitle = win.locator('.pane-header .title')
    await expect(tabTitle.filter({ hasText: /^Hello$/ })).toBeVisible({ timeout: 15_000 })

    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Language', exact: true }).click()
    await settings.getByRole('combobox', { name: 'Display language' }).click()
    await win.getByRole('option', { name: '繁體中文' }).click()

    const translated = win.getByRole('region', { name: '設定' })
    await expect(translated).toBeVisible({ timeout: 10_000 })
    await translated.getByRole('button', { name: '擴充功能', exact: true }).click()
    await expect(translated.getByRole('listitem', { name: '哈囉', exact: true })).toBeVisible({
      timeout: 10_000,
    })
    await expect(translated.getByRole('listitem', { name: 'Hello', exact: true })).toHaveCount(0)

    await paletteOffers(win, '哈囉：開啟面板')
    await win.locator('[data-slot="command-input"]').fill('Hello: Open Panel')
    await expect(
      win.getByRole('dialog').getByText('Hello: Open Panel', { exact: true }),
    ).toHaveCount(0)
    await win.keyboard.press('Escape')
    await expect(tabTitle.filter({ hasText: /^哈囉面板$/ })).toHaveCount(1)
    await expect(tabTitle.filter({ hasText: /^Hello$/ })).toHaveCount(0)

    await translated.getByRole('button', { name: '語言', exact: true }).click()
    await translated.getByRole('combobox', { name: '顯示語言' }).click()
    await win.getByRole('option', { name: 'English' }).click()

    const english = win.getByRole('region', { name: 'Settings' })
    await expect(english).toBeVisible({ timeout: 10_000 })
    await english.getByRole('button', { name: 'Extensions', exact: true }).click()
    await expect(english.getByRole('listitem', { name: 'Hello', exact: true })).toBeVisible({
      timeout: 10_000,
    })
    await paletteOffers(win, 'Hello: Open Panel')
    await win.keyboard.press('Escape')
    await expect(tabTitle.filter({ hasText: /^Hello$/ })).toHaveCount(1)
  } finally {
    await app.close()
  }
})
