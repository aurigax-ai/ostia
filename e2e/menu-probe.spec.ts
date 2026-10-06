import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'

test('probe: application menu on this platform', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const menu = await app.evaluate(({ Menu }) => {
      const m = Menu.getApplicationMenu()
      if (!m) return null
      return m.items.map((i) => ({
        label: i.label,
        items: (i.submenu?.items ?? []).map(
          (s) => `${s.label}|${s.role ?? ''}|${s.accelerator ?? ''}|${s.registerAccelerator}`,
        ),
      }))
    })
    await win.evaluate(() => {
      ;(window as unknown as { __probe: number }).__probe = 1
    })
    await win.locator('body').click()
    await win.keyboard.press('Control+r')
    await win.waitForTimeout(1500)
    const survived = await win
      .evaluate(() => (window as unknown as { __probe?: number }).__probe ?? null)
      .catch(() => 'evaluate-failed')
    throw new Error(
      `MENU_PROBE platform=${process.platform} menu=${JSON.stringify(menu)} survivedCtrlR=${JSON.stringify(survived)}`,
    )
  } finally {
    await app.close()
  }
})
test.skip(false)
void expect
