import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 120_000 })

const EMAIL = 'work@e2e.test'
const ADDED_EMAIL = 'added@e2e.test'

const FAKE_CLAUDE = [
  '#!/bin/sh',
  'echo "fake-claude dir=${CLAUDE_CONFIG_DIR:-unset}"',
  'exec cat',
  '',
].join('\n')

const PROFILE_ID = '0123456789abcdef'

function pendingProfile(dataHome: string): string | null {
  const root = join(dataHome, 'ostia', 'claude-accounts')
  if (!existsSync(root)) return null
  const id = readdirSync(root).find(
    (name) => name !== PROFILE_ID && existsSync(join(root, name, '.ostia-pending')),
  )
  return id ? join(root, id) : null
}

function seedSignedInProfile(dataHome: string): string {
  const profile = join(dataHome, 'ostia', 'claude-accounts', PROFILE_ID)
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(profile, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }),
  )
  writeFileSync(
    join(profile, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: 1 } }),
    { mode: 0o600 },
  )
  return profile
}

test('CLA-E1 Add opens the sign-in this platform uses (a dialog on Linux, a login tab on macOS), a signed-in profile on disk comes back as an account, a new Claude starts on it, and a switch from a pane asks the human every time', async () => {
  const dataHome = freshDataHome()
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  const profile = seedSignedInProfile(dataHome)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const terminal = win.locator('.pane-slot:not([data-hidden]) .xterm-rows').first()

    await typeLine(win, 'claude')
    await expect(terminal).toContainText('fake-claude dir=unset', { timeout: 15_000 })
    await win.keyboard.press('Control+C')

    await win.locator('.topbar').getByRole('button', { name: 'Claude accounts' }).click()
    await win.getByText('Manage accounts…').click()
    const settings = win.getByRole('region', { name: 'Settings' })
    const list = settings.getByRole('list', { name: 'Claude accounts' })
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await settings.getByRole('button', { name: 'Add' }).click()
    if (process.platform === 'darwin') {
      await expect(
        settings.getByText('Sign in to the account in the new terminal tab.'),
      ).toBeVisible()
      await expect(win.getByRole('dialog')).toHaveCount(0)
      await expect.poll(() => pendingProfile(dataHome), { timeout: 15_000 }).not.toBeNull()
      const added = pendingProfile(dataHome) as string
      await expect(
        win
          .locator('.pane-slot:not([data-hidden]) .xterm-rows')
          .filter({ hasText: `fake-claude dir=${added}` }),
      ).toHaveCount(1, { timeout: 15_000 })
      await expect(win.getByText('Add Claude account').first()).toBeVisible()
      writeFileSync(
        join(added, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: ADDED_EMAIL } }),
      )
      await expect(list.getByRole('listitem').filter({ hasText: ADDED_EMAIL })).toBeVisible({
        timeout: 30_000,
      })
      expect(existsSync(join(added, '.ostia-pending'))).toBe(false)
    } else {
      const dialog = win.getByRole('dialog')
      await expect(dialog.getByText('Sign in to Claude in your browser')).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
    }

    await settings.getByRole('button', { name: 'Bring back' }).click()
    await expect(list.getByRole('listitem').filter({ hasText: EMAIL })).toBeVisible({
      timeout: 30_000,
    })

    const row = list.getByRole('listitem').filter({ hasText: EMAIL })
    await row.getByRole('button', { name: `Actions for ${EMAIL}` }).click()
    await win.getByRole('menuitem', { name: 'Switch to' }).click()
    await expect(row).toContainText('Active')

    await win.locator('.rail-tab').filter({ hasText: 'home' }).click()
    await win.locator('.xterm').first().click()
    await typeLine(win, 'claude')
    await expect(terminal).toContainText(`fake-claude dir=${profile}`, { timeout: 15_000 })
    await win.keyboard.press('Control+C')

    await typeLine(win, 'ostia account switch 1')
    await win.getByRole('button', { name: 'Allow once' }).first().click()
    await expect(terminal).toContainText(/1\s+default/, { timeout: 15_000 })
    await win.locator('.xterm').first().click()
    await typeLine(win, 'ostia account switch 2')
    await expect(win.getByRole('button', { name: 'Allow once' }).first()).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})
