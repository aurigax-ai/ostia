import { freshDataHome } from './dataHome'
import { launchWindow, openWorkspace, quitApp } from './helpers'
import { type ElectronApplication, expect, type Page, test } from './test'

const filesButton = (win: Page) =>
  win.locator('.topbar').getByRole('button', { name: 'Files', exact: true })

test('the Files panel is open again after a restart only if it was open', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()

  let session = await launchWindow(dataHome)
  await openWorkspace(session.win)
  await expect(session.win.locator('#files-panel')).toHaveCount(0)
  await filesButton(session.win).click()
  await expect(session.win.locator('#files-panel')).toBeVisible()
  await quitApp(session.app)

  session = await launchWindow(dataHome)
  await expect(session.win.locator('.ghostty-host')).toHaveCount(1, { timeout: 15_000 })
  await expect(session.win.locator('#files-panel')).toBeVisible()
  await expect(filesButton(session.win)).toHaveAttribute('aria-pressed', 'true')
  await filesButton(session.win).click()
  await expect(session.win.locator('#files-panel')).toHaveCount(0)
  await quitApp(session.app)

  session = await launchWindow(dataHome)
  await expect(session.win.locator('.ghostty-host')).toHaveCount(1, { timeout: 15_000 })
  await expect(session.win.locator('#files-panel')).toHaveCount(0)
  await quitApp(session.app)
})

function guestIds(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
      .map((wc) => wc.id)
      .sort(),
  )
}

const toggle = (win: Page, name: string) =>
  win.locator('.topbar').getByRole('button', { name, exact: true })

test('the right side panel switches in place without reloading a panel, hides, and comes back with its width after a restart', async () => {
  test.setTimeout(150_000)
  const dataHome = freshDataHome()

  let session = await launchWindow(dataHome)
  const { app, win } = session
  await openWorkspace(win)
  const dock = win.locator('#right-panel')
  await expect(dock).toHaveAttribute('data-hidden', '')

  await toggle(win, 'Graphs').click()
  await expect(dock).not.toHaveAttribute('data-hidden')
  await expect(dock).toHaveAttribute('aria-label', 'Graphs')
  await expect.poll(() => guestIds(app), { timeout: 30_000 }).toHaveLength(1)
  const [graphs] = await guestIds(app)

  await toggle(win, 'Activity').click()
  await expect(dock).toHaveAttribute('aria-label', 'Activity')
  await expect.poll(() => guestIds(app), { timeout: 30_000 }).toHaveLength(2)
  expect(await guestIds(app)).toContain(graphs)
  const both = await guestIds(app)

  await toggle(win, 'Graphs').click()
  await expect(dock).toHaveAttribute('aria-label', 'Graphs')
  expect(await guestIds(app)).toEqual(both)

  const resizer = win.getByRole('separator', { name: 'Resize Graphs' })
  const before = Number(await resizer.getAttribute('aria-valuenow'))
  await resizer.focus()
  for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowLeft')
  await expect(resizer).toHaveAttribute('aria-valuenow', String(before + 48))

  await toggle(win, 'Graphs').click()
  await expect(dock).toHaveAttribute('data-hidden', '')
  expect(await guestIds(app)).toEqual(both)
  await toggle(win, 'Graphs').click()
  await expect(dock).not.toHaveAttribute('data-hidden')
  expect(await guestIds(app)).toEqual(both)
  await dock.getByRole('button', { name: 'Close Graphs' }).click()
  await expect(dock).toHaveAttribute('data-hidden', '')
  expect(await guestIds(app)).toEqual(both)
  await toggle(win, 'Graphs').click()
  await expect(dock).not.toHaveAttribute('data-hidden')
  await quitApp(app)

  session = await launchWindow(dataHome)
  await expect(session.win.locator('.ghostty-host')).toHaveCount(1, { timeout: 15_000 })
  await expect(session.win.locator('#right-panel')).toHaveAttribute('aria-label', 'Graphs')
  await expect(session.win.locator('#right-panel')).not.toHaveAttribute('data-hidden')
  await expect(session.win.getByRole('separator', { name: 'Resize Graphs' })).toHaveAttribute(
    'aria-valuenow',
    String(before + 48),
  )
  await quitApp(session.app)
})
