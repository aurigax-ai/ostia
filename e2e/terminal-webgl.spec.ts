import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { addTab, openWorkspace, typeLine } from './helpers'
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

test('a hidden xterm pane keeps its WebGL context and draws what it printed once shown', async () => {
  test.setTimeout(60_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, { behavior: { gpuAcceleration: true } })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, args: [SOFTWARE_WEBGL, ...launch.args] })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const first = win.locator('.xterm').first()
    const canvas = first.locator('.xterm-screen canvas').first()
    await expect(canvas).toHaveCount(1)
    await canvas.evaluate((el) => {
      el.setAttribute('data-kept', 'first')
    })
    await first.click()
    await typeLine(win, `sleep 2; ${RED_BLOCKS}`)

    await addTab(win)
    const tabs = win.getByRole('tablist').getByRole('tab')
    await expect(tabs).toHaveCount(2, { timeout: 15_000 })
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await win.waitForTimeout(3_000)

    await tabs.nth(0).click()
    await expect(first.locator('canvas[data-kept="first"]')).toHaveCount(1)
    await expect(win.locator('.xterm-rows')).toHaveCount(0)
    const screen = first.locator('.xterm-screen')
    await expect.poll(async () => redRowGaps(await screen.screenshot(), win)).toBe(0)
  } finally {
    await app.close()
  }
})
