import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const FAKE_BIN = resolve(__dirname, '../test/fixtures/system/bin')

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

function askedDialogs(app: ElectronApplication): Promise<unknown[]> {
  return app.evaluate(() => (globalThis as { ostiaE2eAsked?: unknown[] }).ostiaE2eAsked ?? [])
}

test(
  'ostia system install asks the human, then runs the command in a new terminal',
  { tag: ['@core', '@race'] },
  async () => {
    const dataHome = freshDataHome()
    const home = join(dataHome, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.bashrc'), "PS1='runner@ostia-linux-runner-pqdgm:\\w\\$ '\n")
    const log = join(dataHome, 'system-calls.log')
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({
      ...launch,
      env: {
        ...launch.env,
        HOME: home,
        PATH: `${FAKE_BIN}:${process.env.PATH}`,
        FAKE_SYSTEM_LOG: log,
      },
    })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      await answerDialogsWith(app, 0)

      const agent = win.locator('.ghostty-host').first()
      await agent.click()
      await win.keyboard.type('ostia system install ripgrep --manager pacman --reason e2e-check')
      await win.keyboard.press('Enter')

      await expect(win.locator('.ghostty-host')).toHaveCount(2, { timeout: 20_000 })
      const installer = win.locator('.terminal-text').filter({ hasText: 'fake pacman installed' })
      await expect(installer).toContainText('fake pacman installed: -S --needed ripgrep', {
        timeout: 20_000,
      })
      const agentRows = win.locator('.terminal-text').filter({ hasText: 'e2e-check' })
      await expect(agentRows).toContainText('"approved": true', { timeout: 15_000 })
      const asked = await askedDialogs(app)
      expect(asked).toHaveLength(1)
      expect(readFileSync(log, 'utf8')).toContain('pacman -S --needed ripgrep')
    } finally {
      await app.close()
    }
  },
)
