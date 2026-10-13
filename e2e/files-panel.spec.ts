import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('the Files button opens the Files panel and closes it again', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const files = win.locator('.topbar').getByRole('button', { name: 'Files', exact: true })
    const panel = win.locator('.files-panel')
    await expect(panel).toHaveCount(0)
    await files.click()
    await expect(panel).toBeVisible()
    await files.click()
    await expect(panel).toHaveCount(0)
  } finally {
    await app.close()
  }
})
