import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, quitApp, waitForPaletteSelection } from './helpers'
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

async function openActivity(win: Page): Promise<void> {
  await win.keyboard.press(chords.palette)
  await win.locator('[data-slot="command-input"]').fill('Activity: Open')
  await waitForPaletteSelection(win, 'Activity: Open')
  await win.keyboard.press('Enter')
}

async function shot(win: Page, name: string): Promise<void> {
  if (SHOTS) await win.screenshot({ path: `${SHOTS}/sync-cards-${name}.png` })
}

test('device approvals and new-device warnings show in the Inbox and the dashboard outside Settings', async () => {
  const launch = isolatedLaunch(freshDataHome())
  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await openActivity(win)
    const panel = win.locator('#right-panel')
    await announce(app, ITEMS)
    await panel.getByRole('tab', { name: 'Inbox 4' }).click()
    const cards = panel.locator('[data-sync-attention]')
    await expect(cards).toHaveCount(4, { timeout: 15_000 })
    const join = panel.locator('[data-sync-attention="join:d2"]')
    await expect(join).toContainText('Pixel 9')
    await expect(join).toContainText('K7QDM-2XPLA-VTRHE-4WNBC-GJ5FS')
    await shot(win, 'inbox')

    await join.getByRole('button', { name: 'Deny' }).click()
    await expect(cards).toHaveCount(3)
    await expect(panel.getByRole('tab', { name: 'Inbox 3' })).toBeVisible()

    await win.keyboard.press(chords.dashboard)
    const needs = win.getByRole('region', { name: 'Needs you' })
    await expect(needs.locator('[data-sync-attention]')).toHaveCount(3, { timeout: 15_000 })
    await shot(win, 'dashboard')

    await announce(app, [])
    await expect(needs.locator('[data-sync-attention]')).toHaveCount(0)
  } finally {
    await quitApp(app)
  }
})
