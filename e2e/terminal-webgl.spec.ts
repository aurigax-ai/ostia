import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, emptyWorkspace } from './helpers'
import { redRowGaps } from './pixels'
import { _electron as electron, expect, test } from './test'

test('the GPU renderer draws stacked block characters without gaps between rows', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { behavior: { gpuAcceleration: true } })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
  try {
    const win = await app.firstWindow()
    await emptyState(win)
      .getByRole('button', { name: /New workspace/ })
      .click()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    const screen = win.locator('.xterm-screen').first()
    await expect(screen.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.xterm-rows')).toHaveCount(0)
    await win.waitForTimeout(1_500)
    await win.locator('.xterm').first().click()
    await win.keyboard.type(
      "clear; printf '\\033[38;2;255;0;0m%s\\n%s\\n%s\\033[0m\\n' ███ ███ ███",
    )
    await win.keyboard.press('Enter')
    await expect.poll(async () => redRowGaps(await screen.screenshot(), win)).toBe(0)
  } finally {
    await app.close()
  }
})
