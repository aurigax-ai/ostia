import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('the Ostia prompt shows chips in the input editor and a plain .zshrc prompt in the pty', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, '.zshrc'),
    "export VIRTUAL_ENV=\"$HOME/.venv-ostia\"\nPROMPT='fancy_left❯ '\nRPROMPT='fancy_right'\n",
  )
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
    terminal: {
      prompt: {
        style: 'ostia',
        chips: ['virtualenv', 'cwd', 'exitCode'],
        sameLine: false,
        separator: '$',
      },
    },
  })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, SHELL: '/usr/bin/zsh' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    const chips = win.getByRole('list', { name: 'Prompt' })

    await expect(chips.getByLabel('Python virtualenv: .venv-ostia')).toBeVisible({
      timeout: 15_000,
    })
    await expect(rows).toContainText(/~\s*\$/)
    await expect(rows).not.toContainText('fancy_left')
  } finally {
    await app.close()
  }
})
