import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace, quitApp } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

test.describe.configure({ timeout: 120_000 })

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
    kind: 'approval',
    id: 'approval:a1',
    approvalId: 'a1',
    deviceId: 'd1',
    name: 'Studio laptop',
    createdAt: Date.now() - 5 * 60_000,
  },
  {
    kind: 'changed',
    id: 'changed:d3:1',
    deviceId: 'd3',
    name: 'build-box',
    until: Date.now() + 20 * 3_600_000,
  },
]

async function announce(app: ElectronApplication, items: unknown[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, list) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('syncServer:attention', list)
    }
  }, items)
}

async function shot(win: Page, name: string): Promise<void> {
  if (SHOTS)
    await win.screenshot({ path: `${SHOTS}/sync-cards-${name}.png`, animations: 'disabled' })
}

async function signedInServer(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, now) => {
    const hour = 3_600_000
    const day = 24 * hour
    const reply = (channel: string, value: unknown): void => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => value)
    }
    reply('server:status', {
      url: 'https://ostia.example.com',
      host: 'ostia.example.com',
      signedIn: true,
      provider: 'invite',
      deviceName: 'Work laptop',
    })
    reply('server:info', {
      ok: true,
      offer: { relay: true, publish: false, sync: true, push: false, invite: true, github: false },
    })
    reply('server:devices', {
      ok: true,
      devices: [
        {
          id: 'me',
          name: 'Work laptop',
          current: true,
          lastSeen: now,
          createdAt: now - 40 * day,
        },
        {
          id: 'd1',
          name: 'Studio laptop',
          current: false,
          lastSeen: now,
          createdAt: now - 3 * hour,
        },
        {
          id: 'd3',
          name: 'build-box',
          current: false,
          lastSeen: now,
          createdAt: now - hour,
        },
        {
          id: 'd2',
          name: 'Pixel 9',
          current: false,
          lastSeen: now,
          createdAt: now - 2 * 60_000,
        },
      ],
    })
    reply('server:approvals', { ok: true, approvals: [] })
    reply('syncServer:status', {
      state: 'ready',
      host: 'ostia.example.com',
      linking: false,
      linkApproved: false,
      linkCodes: [],
      joins: [],
      recoveryStale: false,
      wrapRefused: null,
      changedDevices: [],
    })
    const synced = {
      dir: null,
      state: 'ok',
      lastSync: new Date().toISOString(),
      conflicts: [],
      skipped: [],
      heldBack: [],
      offers: [],
      secrets: { state: 'off', logins: false },
    }
    reply('sync:status', synced)
    reply('sync:run', synced)
  }, Date.now())
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
    await signedInServer(app)
    await announce(app, ITEMS)
    const nav = (name: string) =>
      settings.getByRole('navigation').getByRole('button', { name, exact: true })

    await openPage(app, 'sync')
    await expect(settings.getByRole('heading', { name: 'Sync' })).toBeVisible({ timeout: 15_000 })
    const requests = settings.getByRole('list', { name: 'Requests' })
    await expect(requests.getByText('Pixel 9')).toBeVisible()
    await expect(requests.getByText('K7QDM-2XPLA-VTRHE-4WNBC-GJ5FS')).toBeVisible()
    await expect(settings.getByText(/Keys changed/)).toBeHidden()
    await expect(settings.getByText(/Asks to confirm/)).toBeHidden()
    await expect(nav('Sync')).toHaveAttribute('aria-current', 'page')
    await expect(settings.getByText('Where to sync')).toHaveCount(1)
    await expect(settings.locator('[data-settings-row]').first()).toContainText(
      /Status.*Sync is on for this device\./,
    )
    await expect(settings.getByText(/not signed in|Sign in to a server first/)).toBeHidden()
    await shot(win, 'split-sync')

    await openPage(app, 'server')
    await expect(settings.getByRole('heading', { name: 'Server' })).toBeVisible()
    await expect(settings.getByText(/Asks to confirm a change · added 3 hours ago/)).toBeVisible()
    await expect(settings.getByRole('list', { name: 'Requests' })).toBeHidden()
    await expect(settings.getByText(/^Keys changed · sync key ignored until /)).toBeVisible()
    await expect(settings.getByText('Changed', { exact: true })).toBeVisible()
    await expect(nav('Server')).toHaveAttribute('aria-current', 'page')
    await shot(win, 'split-server')

    await announce(app, [])
    await expect(settings.getByText(/Asks to confirm/)).toBeHidden()
  } finally {
    await quitApp(app)
  }
})
