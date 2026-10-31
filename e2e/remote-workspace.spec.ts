import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const FAKE_SSH_BIN = resolve(__dirname, '../test/fixtures/ssh/bin')
const SSH_CAPTURES = resolve(__dirname, '../test/fixtures/ssh')

async function answerDialogsWith(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    dialog.showMessageBox = (async () => ({
      response: answer,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox
  }, response)
}

test('REM-E1 a remote workspace is set up from the menu, shows Online and lists its job', async () => {
  test.setTimeout(150_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  const launch = isolatedLaunch(dataHome)
  mkdirSync(join(launch.env.HOME, '.ssh'), { recursive: true })
  writeFileSync(join(launch.env.HOME, '.ssh', 'config'), 'Host build-box\n  HostName 10.0.0.5\n')
  const remoteHome = mkdtempSync(join(dataHome, 'remote-home-'))
  const remoteTmp = mkdtempSync(join(dataHome, 'remote-tmp-'))
  const stubs = mkdtempSync(join(dataHome, 'remote-stubs-'))
  writeFileSync(join(stubs, 'claude'), '#!/bin/sh\n[ "$1" = auth ] && exit 0\nexec sleep 300\n', {
    mode: 0o700,
  })
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      PATH: `${stubs}:${FAKE_SSH_BIN}:${process.env.PATH}`,
      FAKE_SSH_DIR: SSH_CAPTURES,
      FAKE_SSH_REMOTE_SHELL: '/bin/sh',
      FAKE_SSH_REMOTE_HOME: remoteHome,
      FAKE_SSH_REMOTE_TMP: remoteTmp,
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await answerDialogsWith(app, 0)
    await win.getByRole('button', { name: 'More ways to start a workspace' }).click()
    await win.getByRole('menuitem', { name: 'Remote…' }).click()
    const dialog = win.getByRole('dialog', { name: 'New remote workspace' })
    await expect(dialog.getByRole('combobox', { name: 'Host' })).toContainText('build-box')
    await dialog.getByRole('button', { name: 'Set up' }).click()
    const steps = dialog.getByRole('list', { name: 'Setup steps' })
    await expect(
      steps.getByRole('listitem').filter({ hasText: 'Sign in to the agent' }),
    ).toContainText('Waiting for you', { timeout: 90_000 })
    await dialog.getByRole('button', { name: 'Check again' }).click()
    await expect(dialog).toBeHidden({ timeout: 60_000 })
    await expect(win.getByText('Online')).toBeVisible({ timeout: 30_000 })
    await win.keyboard.press('F1')
    await win
      .getByRole('dialog', { name: 'Command palette' })
      .getByRole('combobox')
      .fill('Remote: Jobs')
    await win.keyboard.press('Enter')
    const jobs = win.getByRole('dialog', { name: 'Jobs on build-box' })
    await expect(jobs.getByRole('listitem')).toHaveCount(1, { timeout: 20_000 })
    await expect(jobs.getByRole('listitem')).toContainText('claude')
  } finally {
    spawnSync('tmux', ['-S', join(remoteHome, '.ostia/node/run/tmux'), 'kill-server'])
    await app.close()
  }
})
