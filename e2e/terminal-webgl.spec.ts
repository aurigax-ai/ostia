import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace, typeLine } from './helpers'
import { RED_BLOCKS, redRowGaps } from './pixels'
import { _electron as electron, expect, test } from './test'

test('the GPU renderer draws stacked block characters without gaps between rows', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { behavior: { gpuAcceleration: true } })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const screen = win.locator('.xterm-screen').first()
    await expect(win.locator('.xterm-rows')).toHaveCount(0)
    await win.locator('.xterm').first().click()
    await typeLine(win, RED_BLOCKS)
    await expect.poll(async () => redRowGaps(await screen.screenshot(), win)).toBe(0)
  } finally {
    await app.close()
  }
})
