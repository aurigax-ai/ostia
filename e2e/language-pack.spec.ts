import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { emptyState, openWorkspace } from './helpers'

test('the Traditional Chinese pack is an extension: pick it, keep it across a restart, lose it when disabled', async () => {
  const dataHome = freshDataHome()
  const first = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await first.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(emptyState(win)).toContainText('No workspaces')
    await openWorkspace(win)

    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Language', exact: true }).click()
    await settings.getByRole('combobox', { name: 'Display language' }).click()
    await win.getByRole('option', { name: '繁體中文' }).click()
    await expect(win.getByRole('region', { name: '設定' })).toBeVisible({ timeout: 10_000 })
    await expect(win.getByRole('combobox', { name: '顯示語言' })).toBeVisible()
    const savedLocale = (): unknown => {
      try {
        return JSON.parse(readFileSync(join(dataHome, 'userData', 'settings.json'), 'utf8')).locale
      } catch {
        return null
      }
    }
    await expect.poll(savedLocale, { timeout: 10_000 }).toBe('zh-Hant')
  } finally {
    await first.close()
  }

  const second = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await second.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.getByText('搜尋或執行指令')).toBeVisible()
    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: '設定' })
    await expect(settings).toBeVisible({ timeout: 15_000 })

    await settings.getByRole('button', { name: '擴充功能', exact: true }).click()
    const pack = settings.getByRole('listitem', { name: '繁體中文 (Traditional Chinese)' })
    await expect(pack.getByRole('switch')).toBeChecked()
    await pack.getByRole('switch').click()

    const english = win.getByRole('region', { name: 'Settings' })
    await expect(english).toBeVisible({ timeout: 10_000 })
    await english.getByRole('button', { name: 'Language', exact: true }).click()
    await english.getByRole('combobox', { name: 'Display language' }).click()
    await expect(win.getByRole('option', { name: 'English' })).toBeVisible()
    await expect(win.getByRole('option', { name: '繁體中文' })).toHaveCount(0)
  } finally {
    await second.close()
  }
})
