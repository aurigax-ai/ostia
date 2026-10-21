import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { API_HOST, type RunningServer, startServer } from './serverHarness'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

const SERVER_BIN = process.env.OSTIA_SERVER_BIN
const PASSPHRASE = 'an e2e passphrase for sync'
const CHECK_CODE = /([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})/
const SEEDED_THEME = 'dracula'
const CHANGED_THEME = 'ostia-light'
const SLOW = { timeout: 30_000 }

interface Machine {
  app: ElectronApplication
  win: Page
}

async function launchMachine(server: RunningServer, seedsTheme = true): Promise<Machine> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    ...(seedsTheme ? { appearance: { followSystem: false, theme: SEEDED_THEME } } : {}),
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
  if (seedsTheme) await expect(win.locator('html')).toHaveAttribute('data-theme', SEEDED_THEME)
  return { app, win }
}

const settingsOf = (win: Page) => win.getByRole('region', { name: 'Settings' })

async function openSettingsPage(win: Page, page: 'Server' | 'Sync'): Promise<void> {
  const settings = settingsOf(win)
  if (!(await settings.isVisible())) {
    await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  }
  await settings.getByLabel('General').getByRole('button', { name: page, exact: true }).click()
}

async function signIn(win: Page, invite: string): Promise<void> {
  await openSettingsPage(win, 'Server')
  const settings = settingsOf(win)
  await settings.getByRole('textbox', { name: 'Invite code' }).fill(invite)
  await settings.getByRole('button', { name: 'Sign in' }).click()
  await expect(settings.getByText(/^Signed in as .* with an invite code\.$/)).toBeVisible(SLOW)
}

async function chooseServerMethod(win: Page): Promise<void> {
  await openSettingsPage(win, 'Sync')
  const where = settingsOf(win).getByRole('group', { name: 'Where to sync' })
  await where.getByRole('button', { name: 'Server' }).click()
  await expect(where.getByRole('button', { name: 'Server' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
}

async function setUpSync(win: Page): Promise<void> {
  const settings = settingsOf(win)
  await settings.getByRole('textbox', { name: 'New sync passphrase' }).fill(PASSPHRASE)
  await settings.getByRole('textbox', { name: 'Type it again' }).fill(PASSPHRASE)
  await settings.getByRole('button', { name: 'Turn on sync' }).click()
  const dialog = win.getByRole('alertdialog')
  await expect(dialog.getByText(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/)).toBeVisible(SLOW)
  await dialog.getByRole('button', { name: 'I saved it' }).click()
  await expect(settings.getByText('Sync is on for this device.')).toBeVisible(SLOW)
}

async function syncNow(win: Page): Promise<void> {
  await openSettingsPage(win, 'Sync')
  await settingsOf(win).getByRole('button', { name: 'Sync now' }).click()
}

async function expectTheme(win: Page, theme: string): Promise<void> {
  await expect(async () => {
    await syncNow(win)
    await expect(win.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

async function themeOnDisk(win: Page): Promise<string> {
  return win.evaluate(async () => {
    const res = await window.ostia.fs.read(await window.ostia.settings.path())
    return res.ok ? String(JSON.parse(res.text).appearance?.theme) : ''
  })
}

async function keepOtherMachineValues(win: Page): Promise<void> {
  const other = settingsOf(win).getByRole('button', { name: 'Use the other value' })
  await expect(other.first()).toBeVisible(SLOW)
  while ((await other.count()) > 0) {
    await other.first().click()
    await expect(async () => {
      await syncNow(win)
    }).toPass({ timeout: 10_000 })
  }
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

async function makeCode(win: Page): Promise<string> {
  const settings = settingsOf(win)
  await settings.getByRole('button', { name: 'Make a code' }).click()
  const code = settings
    .getByText('One-time code', { exact: true })
    .locator('xpath=following-sibling::*[1]')
  await expect(code).toBeVisible(SLOW)
  return (await code.innerText()).trim()
}

async function approveRequest(win: Page): Promise<void> {
  const settings = settingsOf(win)
  await expect(settings.getByText('Confirmation requested')).toBeVisible(SLOW)
  await settings.getByRole('button', { name: 'Approve', exact: true }).click()
}

test.describe('profile sync through the server end to end', () => {
  test.skip(!SERVER_BIN, 'set OSTIA_SERVER_BIN to a built ostia-server')

  test('two machines converge, a device is linked by approval, and removing one rotates the key', async () => {
    test.setTimeout(420_000)
    const server = await startServer(SERVER_BIN ?? '', { approverMinAge: '0s' })
    const machines: Machine[] = []
    try {
      const first = await launchMachine(server)
      machines.push(first)
      await signIn(first.win, server.invite())
      await chooseServerMethod(first.win)
      await setUpSync(first.win)

      await openSettingsPage(first.win, 'Server')
      const linkCode = await makeCode(first.win)

      const second = await launchMachine(server)
      machines.push(second)
      await signIn(second.win, linkCode)
      await chooseServerMethod(second.win)
      const secondSettings = settingsOf(second.win)
      await secondSettings.getByRole('button', { name: 'Approve from another device' }).click()
      const shown = secondSettings.getByText(CHECK_CODE)
      await expect(shown).toBeVisible(SLOW)
      const checkCode = CHECK_CODE.exec(await shown.innerText())?.[1] ?? ''

      await openSettingsPage(first.win, 'Sync')
      const firstSettings = settingsOf(first.win)
      await expect(firstSettings.getByText('A new device was added', { exact: false })).toBeVisible(
        SLOW,
      )
      const asks = firstSettings.getByText(/wants to join your synced data/)
      await expect(asks).toBeVisible(SLOW)
      expect(await asks.innerText()).toContain(checkCode)
      await firstSettings.getByRole('button', { name: 'It is mine' }).click()
      await firstSettings.getByRole('button', { name: 'Approve', exact: true }).click()
      await secondSettings.getByRole('button', { name: 'The codes match' }).click()
      await expect(secondSettings.getByText('Sync is on for this device.')).toBeVisible(SLOW)

      await changeTheme(first.win, CHANGED_THEME)
      await expectTheme(second.win, CHANGED_THEME)

      await openSettingsPage(first.win, 'Server')
      const thirdCodePending = makeCode(first.win)
      await openSettingsPage(second.win, 'Server')
      await approveRequest(second.win)
      const thirdCode = await thirdCodePending

      const third = await launchMachine(server, false)
      machines.push(third)
      await signIn(third.win, thirdCode)
      await chooseServerMethod(third.win)
      const thirdSettings = settingsOf(third.win)
      await thirdSettings.getByRole('textbox', { name: 'Sync passphrase' }).fill(PASSPHRASE)
      await thirdSettings.getByRole('button', { name: 'Unlock', exact: true }).click()
      await expect(thirdSettings.getByText('Sync is on for this device.')).toBeVisible(SLOW)
      await syncNow(third.win)
      await keepOtherMachineValues(third.win)
      await expect.poll(() => themeOnDisk(third.win), SLOW).toBe(CHANGED_THEME)

      await openSettingsPage(first.win, 'Sync')
      await firstSettings.getByRole('button', { name: 'Remove', exact: true }).last().click()
      await first.win.getByLabel('Sync passphrase').fill(PASSPHRASE)
      await first.win.getByRole('button', { name: 'Remove device' }).click()
      const removed = firstSettings.getByText(
        'The device was removed and the sync key was changed.',
      )
      const waiting = firstSettings.getByText(
        'Waiting for you to approve this on another of your devices.',
      )
      await expect(removed.or(waiting)).toBeVisible(SLOW)
      if (await waiting.isVisible()) {
        await approveRequest(second.win)
      }
      await expect(removed).toBeVisible(SLOW)

      await changeTheme(first.win, SEEDED_THEME)
      await expectTheme(second.win, SEEDED_THEME)

      await openSettingsPage(third.win, 'Sync')
      await syncNow(third.win)
      await expect(thirdSettings.getByRole('status')).toContainText(
        'This computer is not signed in to the server.',
        SLOW,
      )
    } finally {
      for (const machine of machines) await machine.app.close()
      await server.stop()
    }
  })
})
