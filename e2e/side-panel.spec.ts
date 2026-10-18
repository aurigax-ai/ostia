import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, quitApp } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

async function launch(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

const filesButton = (win: Page) =>
  win.locator('.topbar').getByRole('button', { name: 'Files', exact: true })

test('the Files panel is open again after a restart only if it was open', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()

  let session = await launch(dataHome)
  await openWorkspace(session.win)
  await expect(session.win.locator('#files-panel')).toHaveCount(0)
  await filesButton(session.win).click()
  await expect(session.win.locator('#files-panel')).toBeVisible()
  await quitApp(session.app)

  session = await launch(dataHome)
  await expect(session.win.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })
  await expect(session.win.locator('#files-panel')).toBeVisible()
  await expect(filesButton(session.win)).toHaveAttribute('aria-pressed', 'true')
  await filesButton(session.win).click()
  await expect(session.win.locator('#files-panel')).toHaveCount(0)
  await quitApp(session.app)

  session = await launch(dataHome)
  await expect(session.win.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })
  await expect(session.win.locator('#files-panel')).toHaveCount(0)
  await quitApp(session.app)
})
