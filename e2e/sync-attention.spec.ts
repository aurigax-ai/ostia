import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace, quitApp } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

test.describe.configure({ timeout: 120_000 })

const HOUR = 3_600_000
const SHOTS = process.env.SYNC_CARDS_SHOTS

const ITEMS = [
  {
    kind: 'join',
    id: 'join:d2',
    deviceId: 'd2',
    name: 'Pixel 9',
    code: 'K7QDM-2XPLA-VTRHE-4WNBC-GJ5FS',
    createdAt: Date.now() - 2 * 60_000,
  },
  {
    kind: 'new-device',
    id: 'new-device:d3',
    deviceId: 'd3',
    name: 'build-box',
    createdAt: Date.now() - HOUR,
  },
  {
    kind: 'approval',
    id: 'approval:a1',
    approvalId: 'a1',
    name: 'Studio laptop',
    deviceCreatedAt: Date.now() - 3 * HOUR,
    createdAt: Date.now() - 5 * 60_000,
  },
  { kind: 'changed', id: 'changed:Studio laptop', names: ['Studio laptop'] },
]

async function announce(app: ElectronApplication, items: unknown[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, list) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('syncServer:attention', list)
    }
  }, items)
}

async function shot(win: Page, name: string): Promise<void> {
  if (SHOTS) await win.screenshot({ path: `${SHOTS}/sync-cards-${name}.png` })
}

async function openPage(app: ElectronApplication, page: 'server' | 'sync'): Promise<void> {
  await app.evaluate(({ BrowserWindow }, target) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('syncServer:open', target)
  }, page)
}

test('the join request and changed devices show on Settings › Sync, the confirmation and new device on Settings › Server, and a notification click opens its page', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, sync: { method: 'server' } })
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeHidden()
    await announce(app, ITEMS)

    await openPage(app, 'sync')
    await expect(settings.getByRole('heading', { name: 'Sync' })).toBeVisible({ timeout: 15_000 })
    await expect(
      settings.getByText(/Pixel 9 wants to join.*K7QDM-2XPLA-VTRHE-4WNBC-GJ5FS/),
    ).toBeVisible()
    await expect(
      settings.getByText(
        /Studio laptop: keys or creation date changed, so it counts as a new device/,
      ),
    ).toBeVisible()
    await expect(settings.getByText(/build-box/)).toBeHidden()
    await expect(settings.getByText(/asks you to confirm/)).toBeHidden()
    await shot(win, 'split-sync')

    await openPage(app, 'server')
    await expect(settings.getByRole('heading', { name: 'Server' })).toBeVisible()
    await expect(settings.getByText(/A new device was added: build-box/)).toBeVisible()
    await expect(settings.getByText(/Studio laptop asks you to confirm/)).toBeVisible()
    await expect(settings.getByText(/Pixel 9 wants to join/)).toBeHidden()
    await expect(settings.getByText(/keys or creation date changed/)).toBeHidden()
    await shot(win, 'split-server')

    await announce(app, [])
    await expect(settings.getByText(/A new device was added/)).toBeHidden()
  } finally {
    await quitApp(app)
  }
})
