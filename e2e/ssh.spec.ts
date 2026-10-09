import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const FAKE_SSH_BIN = resolve(__dirname, '../test/fixtures/ssh/bin')
const SSH_CAPTURES = resolve(__dirname, '../test/fixtures/ssh')

interface AskedDialog {
  title?: string
  message?: string
  detail?: string
  buttons?: string[]
}

async function answerDialogsWith(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    const g = globalThis as { ostiaE2eAsked?: unknown[] }
    g.ostiaE2eAsked = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.ostiaE2eAsked?.push(args.length > 1 ? args[1] : args[0])
      return { response: answer, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, response)
}

function askedDialogs(app: ElectronApplication): Promise<AskedDialog[]> {
  return app.evaluate(
    () => ((globalThis as { ostiaE2eAsked?: unknown[] }).ostiaE2eAsked ?? []) as AskedDialog[],
  )
}

test(
  'SSH-C18 ostia ssh connect asks the human, then runs ssh in a new terminal beside the caller',
  { tag: '@race' },
  async () => {
    const dataHome = freshDataHome()
    const launch = isolatedLaunch(dataHome)
    const home = launch.env.HOME
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'config'), 'Host db\n  HostName 10.0.0.5\n')
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
      await openWorkspace(win)
      await answerDialogsWith(app, 0)

      await win.locator('.xterm').first().click()
      await win.keyboard.type('ostia ssh connect db')
      await win.keyboard.press('Enter')

      await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 20_000 })
      const session = win.locator('.xterm-rows').filter({ hasText: 'fake ssh session' })
      await expect(session).toContainText('fake ssh session: -t -- db', { timeout: 20_000 })
      const callerRows = win.locator('.xterm-rows').filter({ hasText: 'ostia ssh connect db' })
      await expect(callerRows).toContainText('"approved": true', { timeout: 15_000 })
      await expect(callerRows).toContainText('"command": "ssh -t -- db"')
      const callerBox = await win
        .locator('.xterm')
        .filter({ hasText: 'ostia ssh connect db' })
        .boundingBox()
      const sessionBox = await win
        .locator('.xterm')
        .filter({ hasText: 'fake ssh session' })
        .boundingBox()
      expect(sessionBox?.x ?? 0).toBeGreaterThan(callerBox?.x ?? Number.POSITIVE_INFINITY)

      const asked = await askedDialogs(app)
      expect(asked).toHaveLength(1)
      expect(asked[0].message).toContain('db')
      expect(asked[0].detail).toContain('ssh -t -- db')
      expect(asked[0].detail).toContain('dev@10.0.0.5:2200')
      expect(asked[0].detail).toContain('b1, ops@b2:2222')
      expect(asked[0].buttons).toEqual(['Connect', 'Deny'])
      const calls = readFileSync(log, 'utf8').split('\n')
      expect(calls).toHaveLength(3)
      expect(calls[0]).toBe('ssh -G -- db')
      expect(calls[1].startsWith("ssh -t -- db exec sh -c 'p=")).toBe(true)
    } finally {
      await app.close()
    }
  },
)

test('SSH-C39 a session with shell integration shows remote commands as blocks and never moves the local folder', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
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
    await expect(sshPane.locator('.xterm-rows')).toContainText('remote$', { timeout: 20_000 })
    await expect(sshPane.getByRole('textbox', { name: 'Command input' })).toHaveCount(0)
    expect(readdirSync(remoteTmp)).toEqual([])
    await sshPane.locator('.xterm').click()
    const localTitle = await win.title()
    expect(localTitle).toMatch(/^cwd=\//)

    await win.keyboard.type('cd /tmp')
    await win.keyboard.press('Enter')
    await win.keyboard.type('echo hello-$((40+2))')
    await win.keyboard.press('Enter')
    await expect(sshPane.locator('.xterm-rows')).toContainText('hello-42', { timeout: 15_000 })
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
