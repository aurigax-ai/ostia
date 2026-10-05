import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'

const FAKE_SSH_BIN = resolve(__dirname, '../test/fixtures/ssh/bin')
const SSH_CAPTURES = resolve(__dirname, '../test/fixtures/ssh')

async function declineDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({
      response: 1,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox
  })
}

test('SSH-C79 the human picks a host from the New workspace menu and gets a workspace that is just that ssh session', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const home = launch.env.HOME
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(
    join(home, '.ssh', 'config'),
    'Host db\n  HostName 10.0.0.5\nHost px\n  HostName 10.0.0.6\nHost *\n  User dev\n',
  )
  const log = join(dataHome, 'ssh-calls.log')
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      PATH: `${FAKE_SSH_BIN}:${process.env.PATH}`,
      FAKE_SSH_DIR: SSH_CAPTURES,
      FAKE_SSH_LOG: log,
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await declineDialogs(app)

    await win.getByRole('button', { name: 'More ways to start a workspace' }).click()
    await win.getByRole('menuitem', { name: 'Connect to SSH host' }).click()
    await expect(win.getByRole('menuitem', { name: 'px', exact: true })).toBeVisible({
      timeout: 15_000,
    })
    await expect(win.getByRole('menuitem', { name: '*' })).toHaveCount(0)
    await win.getByRole('menuitem', { name: 'db', exact: true }).click()

    const session = win.locator('.xterm-rows').filter({ hasText: 'fake ssh session' })
    await expect(session).toContainText('fake ssh session: -t -- db', { timeout: 30_000 })
    await expect(win.locator('.xterm:visible')).toHaveCount(1)
    await expect(win.getByRole('tab', { name: /db/ })).toHaveCount(1)
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    expect(calls[0]).toBe('ssh -G -- db')
  } finally {
    await app.close()
  }
})
