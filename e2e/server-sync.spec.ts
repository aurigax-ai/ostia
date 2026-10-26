import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { API_HOST, type RunningServer, startServer } from './serverHarness'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

const SERVER_BIN = process.env.OSTIA_SERVER_BIN
const PASSPHRASE = 'an e2e passphrase for sync'
const NEW_PASSPHRASE = 'a changed e2e passphrase'
const RECOVERY_KEY = /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/
const SEEDED_THEME = 'dracula'
const CHANGED_THEME = 'ostia-light'
const SLOW = { timeout: 30_000 }

interface Machine {
  app: ElectronApplication
  win: Page
  accountId: () => string
}

async function launchMachine(server: RunningServer): Promise<Machine> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    appearance: { followSystem: false, theme: SEEDED_THEME },
  })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    args: ['--password-store=basic', ...launch.args],
    env: {
      ...launch.env,
      OSTIA_SERVER_URL: `https://${API_HOST}:${server.port}`,
      NODE_EXTRA_CA_CERTS: server.caPath,
    },
  })
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator('html')).toHaveAttribute('data-theme', SEEDED_THEME)
  const configPath = join(launch.env.XDG_DATA_HOME ?? '', 'ostia', 'server-config.json')
  const accountId = (): string =>
    String(JSON.parse(readFileSync(configPath, 'utf8')).identity?.accountId ?? '')
  return { app, win, accountId }
}

const settingsOf = (win: Page) => win.getByRole('region', { name: 'Settings' })

async function openSync(win: Page): Promise<void> {
  const settings = settingsOf(win)
  if (!(await settings.isVisible())) {
    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  }
  await settings
    .getByLabel('General', { exact: true })
    .getByRole('button', { name: 'Sync', exact: true })
    .click()
}

async function signIn(win: Page, invite: string): Promise<void> {
  await openSync(win)
  const settings = settingsOf(win)
  const method = settings.getByRole('combobox', { name: 'Sync method' })
  await method.click()
  await win.getByRole('option', { name: 'Ostia server' }).click()
  await expect(method).toContainText('Ostia server')
  await settings.getByRole('button', { name: 'Sign in', exact: true }).click()
  const dialog = win.getByRole('dialog', { name: 'Sign in' })
  await dialog.getByRole('textbox', { name: 'Invite code' }).fill(invite)
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(settings.getByText(/^Signed in as .* with an invite code\./)).toBeVisible(SLOW)
}

async function saveRecoveryKey(win: Page): Promise<string> {
  const saved = win.getByRole('dialog', { name: 'Save your recovery key' })
  const key = saved.getByText(RECOVERY_KEY)
  await expect(key).toBeVisible(SLOW)
  const text = (await key.innerText()).trim()
  await saved.getByRole('button', { name: 'I saved it' }).click()
  await expect(saved).toBeHidden()
  return text
}

async function createPassphrase(win: Page): Promise<string> {
  const dialog = win.getByRole('dialog', { name: 'Create a sync passphrase' })
  await expect(dialog).toBeVisible(SLOW)
  await dialog.getByLabel('Sync passphrase', { exact: true }).fill(PASSPHRASE)
  await dialog.getByLabel('Type it again', { exact: true }).fill(PASSPHRASE)
  await dialog.getByRole('button', { name: 'Continue' }).click()
  return saveRecoveryKey(win)
}

async function enterPassphrase(win: Page, passphrase: string): Promise<void> {
  const dialog = win.getByRole('dialog', { name: 'Enter your sync passphrase' })
  await expect(dialog).toBeVisible(SLOW)
  await dialog.getByLabel('Sync passphrase', { exact: true }).fill(passphrase)
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog).toBeHidden(SLOW)
}

async function syncNow(win: Page): Promise<void> {
  await openSync(win)
  await settingsOf(win).getByRole('button', { name: 'Sync now' }).click()
}

async function expectTheme(win: Page, theme: string): Promise<void> {
  await expect(async () => {
    await syncNow(win)
    await expect(win.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

async function changeTheme(win: Page, theme: string): Promise<void> {
  await win.evaluate(async (next) => {
    const path = await window.ostia.settings.path()
    const res = await window.ostia.fs.read(path)
    const current = JSON.parse(res.ok ? res.text : '{}')
    current.appearance = { ...current.appearance, theme: next }
    await window.ostia.fs.write(path, JSON.stringify(current, null, 2))
  }, theme)
  await expect(win.locator('html')).toHaveAttribute('data-theme', theme)
}

test.describe('profile sync through the server end to end', () => {
  test.skip(!SERVER_BIN, 'set OSTIA_SERVER_BIN to a built ostia-server')

  test('sets up once, a second computer enters the passphrase once, and a passphrase change asks again once', async () => {
    test.setTimeout(300_000)
    const server = await startServer(SERVER_BIN ?? '')
    const machines: Machine[] = []
    try {
      const first = await launchMachine(server)
      machines.push(first)
      await signIn(first.win, server.invite())
      await createPassphrase(first.win)
      await expect(settingsOf(first.win).getByRole('button', { name: 'Sync now' })).toBeVisible()
      await expect(settingsOf(first.win).getByRole('switch', { name: 'Snippets' })).toBeChecked()

      const second = await launchMachine(server)
      machines.push(second)
      await signIn(second.win, server.invite(first.accountId()))
      await enterPassphrase(second.win, PASSPHRASE)
      await syncNow(second.win)

      await changeTheme(first.win, CHANGED_THEME)
      await expectTheme(second.win, CHANGED_THEME)

      await openSync(first.win)
      await settingsOf(first.win).getByRole('button', { name: 'Change passphrase' }).click()
      const change = first.win.getByRole('dialog', { name: 'Change sync passphrase' })
      await change.getByLabel('Current passphrase', { exact: true }).fill(PASSPHRASE)
      await change.getByLabel('New sync passphrase', { exact: true }).fill(NEW_PASSPHRASE)
      await change.getByLabel('Type it again', { exact: true }).fill(NEW_PASSPHRASE)
      await change.getByRole('button', { name: 'Change passphrase' }).click()
      await saveRecoveryKey(first.win)

      await changeTheme(first.win, SEEDED_THEME)
      await syncNow(first.win)
      await syncNow(second.win)
      await enterPassphrase(second.win, NEW_PASSPHRASE)
      await expectTheme(second.win, SEEDED_THEME)
      await expect(second.win.getByRole('dialog')).toBeHidden()
    } finally {
      for (const machine of machines) await machine.app.close()
      await server.stop()
    }
  })
})
