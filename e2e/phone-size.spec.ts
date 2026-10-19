import { freshDataHome, isolatedLaunch } from './dataHome'
import { closeAllWorkspaces, openWorkspace } from './helpers'
import { type ElectronApplication, type Page, expect, launchShared, test } from './test'

let app: ElectronApplication | undefined
let win: Page

test.beforeAll(async () => {
  app = await launchShared(isolatedLaunch(freshDataHome()))
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
})

test.afterEach(async () => {
  await closeAllWorkspaces(win)
})

test.afterAll(async () => {
  await app?.close()
})

function sendSize(paneId: string, cols: number, rows: number): Promise<void> {
  return (app as ElectronApplication).evaluate(
    ({ webContents }, size) => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.getType() === 'window') wc.send(`pty:size:${size.paneId}`, size.cols, size.rows)
      }
    },
    { paneId, cols, rows },
  )
}

test('a pane a phone sized shows a notice, and its action gives the window size back', async ({
  browserName: _b,
}, testInfo) => {
  test.setTimeout(60_000)
  await openWorkspace(win)
  const paneId = await win.locator('.pane[data-pane-id]').first().getAttribute('data-pane-id')
  if (!paneId) throw new Error('no pane id')
  const notice = win.locator(`.pane[data-pane-id="${paneId}"] [data-phone-sized]`)
  await expect(notice).toHaveCount(0)

  await sendSize(paneId, 44, 20)
  await expect(notice).toBeVisible({ timeout: 10_000 })
  await expect(notice).toContainText('Sized for your phone (44 columns).')
  await win.screenshot({ path: testInfo.outputPath('phone-size-notice.png') })

  await notice.getByRole('button', { name: "Use this window's size" }).click()
  await expect(notice).toHaveCount(0)
})
