import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

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
    const g = globalThis as { pineE2eAsked?: unknown[] }
    g.pineE2eAsked = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.pineE2eAsked?.push(args.length > 1 ? args[1] : args[0])
      return { response: answer, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, response)
}

function askedDialogs(app: ElectronApplication): Promise<AskedDialog[]> {
  return app.evaluate(
    () => ((globalThis as { pineE2eAsked?: unknown[] }).pineE2eAsked ?? []) as AskedDialog[],
  )
}

test('SSH-C18 pine ssh connect asks the human, then runs ssh in a new terminal beside the caller', async () => {
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
    await win.keyboard.type('pine ssh connect db')
    await win.keyboard.press('Enter')

    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 20_000 })
    const session = win.locator('.xterm-rows').filter({ hasText: 'fake ssh session' })
    await expect(session).toContainText('fake ssh session: -- db', { timeout: 20_000 })
    const callerRows = win.locator('.xterm-rows').filter({ hasText: 'pine ssh connect db' })
    await expect(callerRows).toContainText('"approved": true', { timeout: 15_000 })
    await expect(callerRows).toContainText('"command": "ssh -- db"')
    const callerBox = await win
      .locator('.xterm')
      .filter({ hasText: 'pine ssh connect db' })
      .boundingBox()
    const sessionBox = await win
      .locator('.xterm')
      .filter({ hasText: 'fake ssh session' })
      .boundingBox()
    expect(sessionBox?.x ?? 0).toBeGreaterThan(callerBox?.x ?? Number.POSITIVE_INFINITY)

    const asked = await askedDialogs(app)
    expect(asked).toHaveLength(1)
    expect(asked[0].message).toContain('db')
    expect(asked[0].detail).toContain('ssh -- db')
    expect(asked[0].detail).toContain('dev@10.0.0.5:2200')
    expect(asked[0].detail).toContain('b1, ops@b2:2222')
    expect(asked[0].buttons).toEqual(['Connect', 'Deny'])
    expect(readFileSync(log, 'utf8').split('\n')).toEqual(['ssh -G -- db', 'ssh -- db', ''])
  } finally {
    await app.close()
  }
})
