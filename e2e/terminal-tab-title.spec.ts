import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch, testHome } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'
import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from './test'

interface Launched {
  app: ElectronApplication
  win: Page
}

const BASHRC_WITHOUT_TITLE = "PROMPT_COMMAND=\nPS1='\\w ❯ '\n"

async function launchWith(shell: string, dataHome: string): Promise<Launched> {
  writeFileSync(join(testHome(dataHome), '.bashrc'), BASHRC_WITHOUT_TITLE)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, SHELL: shell } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (err) {
    await app.close()
    throw err
  }
}

async function quitApp(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {})
  await app.close().catch(() => {})
}

function tabTitles(win: Page): Locator {
  return win.locator('.pane-tab .title')
}

for (const [shell, name] of [
  ['/usr/bin/zsh', 'zsh'],
  ['/usr/bin/bash', 'bash'],
]) {
  test(`a new terminal tab is named after the shell it runs: ${name}`, async () => {
    test.setTimeout(60_000)
    const { app, win } = await launchWith(shell, freshDataHome())
    try {
      await openWorkspace(win)
      await expect(tabTitles(win)).toHaveText([name], { timeout: 15_000 })

      await win.locator('.xterm').first().click()
      await win.keyboard.type('echo "shell=$0"')
      await win.keyboard.press('Enter')
      await expect(win.locator('.xterm-rows').first()).toContainText(`shell=${shell}`, {
        timeout: 15_000,
      })
    } finally {
      await app.close()
    }
  })
}

test('a restored tab is named after the shell it runs now, and a title a program set is kept', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()

  const first = await launchWith('/usr/bin/bash', dataHome)
  try {
    await openWorkspace(first.win)
    await expect(tabTitles(first.win)).toHaveText(['bash'], { timeout: 15_000 })

    await first.win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(first.win.locator('.pane')).toHaveCount(2)
    await expect(tabTitles(first.win)).toHaveText(['bash', 'bash'], { timeout: 15_000 })
    const second = first.win.locator('.pane').nth(1)
    await expect(second.locator('.xterm-rows')).toContainText(PROMPT, { timeout: 15_000 })
    await second.locator('.xterm').click()
    await first.win.keyboard.type("printf '\\033]0;build logs\\007'")
    await first.win.keyboard.press('Enter')
    await expect(tabTitles(first.win)).toHaveText(['bash', 'build logs'], { timeout: 15_000 })
  } finally {
    await quitApp(first.app)
  }

  const restored = await launchWith('/usr/bin/zsh', dataHome)
  try {
    await expect(restored.win.locator('.pane')).toHaveCount(2, { timeout: 15_000 })
    await expect(tabTitles(restored.win)).toHaveText(['zsh', 'build logs'], { timeout: 20_000 })
  } finally {
    await quitApp(restored.app)
  }
})
