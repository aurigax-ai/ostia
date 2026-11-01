import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
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

test('SSH-C39 a session with shell integration shows remote commands as blocks and never moves the local folder', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...CANVAS_RENDERER_SETTINGS,
    behavior: { ...CANVAS_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
    appearance: { windowTitle: 'cwd={cwd}' },
  })
  const launch = isolatedLaunch(dataHome)
  const home = launch.env.HOME
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'config'), 'Host db\n  HostName 10.0.0.5\n')
  const remoteHome = mkdtempSync(join(dataHome, 'remote-home-'))
  const remoteTmp = mkdtempSync(join(dataHome, 'remote-tmp-'))
  writeFileSync(join(remoteHome, '.bash_profile'), "HOSTNAME=fake-remote\nPS1='remote$ '\n")
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      PATH: `${FAKE_SSH_BIN}:${process.env.PATH}`,
      FAKE_SSH_DIR: SSH_CAPTURES,
      FAKE_SSH_REMOTE_SHELL: 'bash',
      FAKE_SSH_REMOTE_HOME: remoteHome,
      FAKE_SSH_REMOTE_TMP: remoteTmp,
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await answerDialogsWith(app, 0)
    const commandInput = win.getByRole('textbox', { name: 'Command input' })
    await expect(commandInput).toBeVisible({ timeout: 20_000 })
    await commandInput.click()
    await win.keyboard.type('ostia ssh connect db')
    await win.keyboard.press('Enter')

    const sshPane = win.locator('[data-pane-id]').filter({ hasText: 'fake ssh session' })
    await expect(sshPane.locator('.terminal-text')).toContainText('remote$', { timeout: 20_000 })
    await expect(sshPane.getByRole('textbox', { name: 'Command input' })).toHaveCount(0)
    expect(readdirSync(remoteTmp)).toEqual([])
    await sshPane.locator('.ghostty-host').click()
    const localTitle = await win.title()
    expect(localTitle).toMatch(/^cwd=\//)

    await win.keyboard.type('cd /tmp')
    await win.keyboard.press('Enter')
    await win.keyboard.type('echo hello-$((40+2))')
    await win.keyboard.press('Enter')
    await expect(sshPane.locator('.terminal-text')).toContainText('hello-42', { timeout: 15_000 })
    await expect
      .poll(() => sshPane.locator('.block-gutter').count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2)
    await expect(sshPane.getByRole('textbox', { name: 'Command input' })).toHaveCount(0)
    expect(await win.title()).toBe(localTitle)

    await win.keyboard.type('exit')
    await win.keyboard.press('Enter')
    const localInput = sshPane.getByRole('textbox', { name: 'Command input' })
    await expect(localInput).toBeVisible({ timeout: 15_000 })
    await localInput.click()
    await win.keyboard.type('cd /tmp')
    await win.keyboard.press('Enter')
    await expect.poll(() => win.title(), { timeout: 10_000 }).toBe('cwd=/tmp')
  } finally {
    await app.close()
  }
})
