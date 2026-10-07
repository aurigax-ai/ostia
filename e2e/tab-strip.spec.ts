import { _electron as electron, expect, test } from './test'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

test('double-clicking the empty part of the tab strip opens a new terminal tab', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const strip = win.getByRole('tablist')
    await expect(strip.getByRole('tab')).toHaveCount(1)

    const lastTab = await strip.locator('.pane-tab').last().boundingBox()
    const box = await strip.boundingBox()
    if (!lastTab || !box) throw new Error('tab strip is not laid out')
    const emptyX = lastTab.x + lastTab.width + 40
    expect(emptyX).toBeLessThan(box.x + box.width)

    await win.mouse.dblclick(emptyX, box.y + box.height / 2)
    await expect(strip.getByRole('tab')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })

    await strip.getByRole('tab').first().dblclick()
    await expect(strip.getByRole('tab')).toHaveCount(2)
  } finally {
    await app.close()
  }
})
