import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

const FAKE_BIN = resolve(__dirname, '../test/fixtures/system/bin')

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

for (const run of [...Array(15).keys()]) test(`ostia system install asks the human, then runs the command in a new terminal beside the agent #${run}`, async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
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

    const agent = win.locator('.xterm').first()
    await agent.click()
    await win.keyboard.type('ostia system install ripgrep --manager pacman --reason e2e-check')
    const jiggle = app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const [width, height] = w.getSize()
      for (let i = 0; i < 14; i++) {
        w.setSize(width + (i % 2 ? 37 : 0), height)
        await new Promise((r) => setTimeout(r, 160))
      }
      w.setSize(width, height)
    })
    await win.keyboard.press('Enter')

    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 20_000 })
    await jiggle
    const installer = win.locator('.xterm-rows').filter({ hasText: 'fake pacman installed' })
    await expect(installer).toContainText('fake pacman installed: -S --needed ripgrep', {
      timeout: 20_000,
    })
    const agentRows = win.locator('.xterm-rows').filter({ hasText: 'e2e-check' })
    await expect(agentRows).toContainText('"approved": true', { timeout: 15_000 })
    await expect(agentRows).toContainText('pacman -S --needed ripgrep')
    const agentBox = await win.locator('.xterm').filter({ hasText: 'e2e-check' }).boundingBox()
    const installerBox = await win
      .locator('.xterm')
      .filter({ hasText: 'fake pacman installed' })
      .boundingBox()
    expect(installerBox?.x ?? 0).toBeGreaterThan(agentBox?.x ?? Number.POSITIVE_INFINITY)

    const asked = await askedDialogs(app)
    expect(asked).toHaveLength(1)
    expect(asked[0].message).toContain('ripgrep')
    expect(asked[0].detail).toContain('pacman -S --needed ripgrep')
    expect(asked[0].detail).toContain('e2e-check')
    expect(asked[0].buttons).toEqual(['Approve', 'Deny'])
    expect(readFileSync(log, 'utf8')).toContain('pacman -S --needed ripgrep')

    await answerDialogsWith(app, 1)
    await win.locator('.xterm').filter({ hasText: 'e2e-check' }).click()
    await win.keyboard.type('ostia system install fd --manager pacman --reason e2e-deny')
    await win.keyboard.press('Enter')
    const denyRows = win.locator('.xterm-rows').filter({ hasText: 'e2e-deny' })
    await expect(denyRows).toContainText('"approved": false', { timeout: 15_000 })
    await expect(denyRows).toContainText('denied')
    expect(await askedDialogs(app)).toHaveLength(1)
    await expect(win.locator('.xterm')).toHaveCount(2)
    expect(existsSync(log) && readFileSync(log, 'utf8')).not.toContain('--needed fd')
  } finally {
    await app.close()
  }
})
