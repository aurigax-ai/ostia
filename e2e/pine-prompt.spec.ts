import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

const SHELLS = [
  {
    shell: '/usr/bin/zsh',
    rc: '.zshrc',
    body: "export VIRTUAL_ENV=\"$HOME/.venv-pine\"\nPROMPT='fancy_left❯ '\nRPROMPT='fancy_right'\n",
  },
  {
    shell: '/usr/bin/bash',
    rc: '.bashrc',
    body: 'export VIRTUAL_ENV="$HOME/.venv-pine"\nPS1=\'fancy_left❯ \'\n',
  },
]

for (const { shell, rc, body } of SHELLS) {
  test(`the Pine prompt shows chips in the input editor and a plain ${rc} prompt in the pty`, async () => {
    test.setTimeout(90_000)
    const dataHome = freshDataHome()
    const home = join(dataHome, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, rc), body)
    seedSettings(dataHome, {
      ...DOM_RENDERER_SETTINGS,
      behavior: { ...DOM_RENDERER_SETTINGS.behavior, inputMode: 'editor' },
      terminal: {
        prompt: {
          style: 'pine',
          chips: ['virtualenv', 'cwd', 'exitCode'],
          sameLine: false,
          separator: '$',
        },
      },
    })
    const launch = isolatedLaunch(dataHome)
    const app = await electron.launch({
      ...launch,
      env: { ...launch.env, HOME: home, SHELL: shell },
    })
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      const rows = win.locator('.xterm-rows').first()
      const chips = win.getByRole('list', { name: 'Prompt' })
      const input = win.getByRole('textbox', { name: 'Command input' })

      await expect(input).toBeVisible({ timeout: 15_000 })
      await expect(chips.getByLabel('Python virtualenv: .venv-pine')).toBeVisible({
        timeout: 15_000,
      })
      await expect(chips.getByLabel('Working directory: ~')).toBeVisible()
      await expect(chips.getByLabel(/Last exit code/)).toHaveCount(0)
      await expect(rows).toContainText('~ $')
      await expect(rows).not.toContainText('fancy_left')
      await expect(rows).not.toContainText('fancy_right')

      await input.click()
      await win.keyboard.type('mkdir -p pine_sub && cd pine_sub && false')
      await win.keyboard.press('Enter')
      await expect(chips.getByLabel('Last exit code: 1')).toBeVisible({ timeout: 15_000 })
      await expect(chips.getByLabel('Working directory: ~/pine_sub')).toBeVisible()
      await expect(rows).toContainText('~/pine_sub $')

      await chips.click({ button: 'right' })
      await win.getByRole('menuitem', { name: 'Edit prompt…' }).click()
      const dialog = win.getByRole('dialog', { name: 'Edit prompt' })
      await expect(dialog).toBeVisible()
      const preview = dialog.getByRole('region', { name: 'Preview' })
      await expect(preview.getByLabel('Working directory: ~/pine_sub')).toBeVisible()
      await dialog.getByRole('button', { name: 'Add User' }).click()
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toBeHidden()
      await expect(chips.locator('[data-chip="user"]')).toBeVisible()
    } finally {
      await app.close()
    }
  })
}
