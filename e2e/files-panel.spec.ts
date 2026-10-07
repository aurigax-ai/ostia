import { isolatedLaunch } from './dataHome'
import { PROMPT, emptyWorkspace, openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('the Files panel opens beside the workspace list and follows the active workspace', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await win.keyboard.type('cd /tmp')
    await win.keyboard.press('Enter')

    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    const panel = win.locator('.files-panel')
    const current = panel.locator('.crumb.current')
    await expect(panel).toBeVisible()
    await expect(win.locator('.deck-rail .rail-tab')).toHaveCount(1)
    await expect(current).toHaveText('tmp', { timeout: 15_000 })

    await win.locator('.topbar').getByRole('button', { name: 'New workspace' }).click()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows').first()).toContainText(
      PROMPT,
      { timeout: 15_000 },
    )
    await expect(current).toHaveText('~')

    await win.locator('.deck-rail .rail-tab-main').first().click()
    await expect(current).toHaveText('tmp')

    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await expect(panel).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('the Files panel edge drags wider and keeps its width after closing and reopening', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const filesButton = win.locator('.topbar').getByRole('button', { name: 'Files', exact: true })
    await filesButton.click()
    const panel = win.locator('.files-panel')
    const panelWidth = async (): Promise<number> => {
      const box = await panel.boundingBox()
      if (!box) throw new Error('files panel not laid out')
      return Math.round(box.width)
    }
    await expect(panel).toBeVisible()
    expect(await panelWidth()).toBe(260)

    const handle = win.getByRole('separator', { name: 'Resize Files' })
    const box = await handle.boundingBox()
    if (!box) throw new Error('files handle not laid out')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await win.mouse.move(x, y)
    await win.mouse.down()
    await win.mouse.move(x + 100, y, { steps: 8 })
    await win.mouse.move(x + 200, y, { steps: 8 })
    await win.mouse.up()
    expect(await panelWidth()).toBe(460)
    await expect(handle).toHaveAttribute('aria-valuenow', '460')

    await filesButton.click()
    await expect(panel).toHaveCount(0)
    await filesButton.click()
    await expect.poll(panelWidth).toBe(460)
  } finally {
    await app.close()
  }
})
