import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { expectHeld, openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 120_000 })

const EMAIL = 'work@e2e.test'

const FAKE_CLAUDE = [
  '#!/bin/sh',
  'echo "fake-claude dir=${CLAUDE_CONFIG_DIR:-unset}"',
  'exec cat',
  '',
].join('\n')

const PROFILE_ID = '0123456789abcdef'

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

test('CLA-E1 Add opens the in-app sign-in, a signed-in profile on disk comes back as an account, a new Claude starts on it, and a switch from a pane asks the human every time', async () => {
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
    const dialog = win.getByRole('dialog')
    await expect(dialog.getByText('Sign in to Claude in your browser')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    await settings.getByRole('button', { name: 'Bring back' }).click()
    await expect(list.getByRole('listitem').filter({ hasText: EMAIL })).toBeVisible({
      timeout: 30_000,
    })

    const row = list.getByRole('listitem').filter({ hasText: EMAIL })
    await row.getByRole('button', { name: `Switch to ${EMAIL}` }).click()
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

function movingClaude(log: string, gate: string): string {
  return [
    '#!/bin/sh',
    'mode=idle',
    'session=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    --resume) session=$2; shift ;;',
    '    busy) mode=busy ;;',
    '  esac',
    '  shift',
    'done',
    'session=${session:-e2e-$mode}',
    `echo "\${CLAUDE_CONFIG_DIR:-unset} $session" >> "${log}"`,
    'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude "$session" >/dev/null 2>&1',
    'if [ "$mode" = busy ]; then',
    '  ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" state working >/dev/null 2>&1',
    `  while [ ! -e "${gate}" ]; do sleep 0.1; done`,
    '  ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" state done >/dev/null 2>&1',
    'fi',
    'echo fake-claude-ready',
    'exec cat',
    '',
  ].join('\n')
}

test('CLA-E2 a switch moves an idle Claude to the new account at once and a working one when its turn ends, each resuming its own session', async () => {
  const dataHome = freshDataHome()
  const bin = join(dataHome, 'bin')
  const log = join(dataHome, 'claude-starts.log')
  const gate = join(dataHome, 'turn-ends')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), movingClaude(log, gate))
  chmodSync(join(bin, 'claude'), 0o755)
  const profile = seedSignedInProfile(dataHome)
  writeFileSync(
    join(dataHome, 'ostia', 'claude-accounts.json'),
    JSON.stringify({ v: 1, accounts: [{ id: PROFILE_ID, email: EMAIL, addedAt: 1 }] }),
    { mode: 0o600 },
  )
  const starts = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
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
    await typeLine(
      win,
      'ostia agent run claude idle --name idle && ostia agent run claude busy --name busy; echo started-$?',
    )
    await expect(terminal).toContainText('started-0', { timeout: 60_000 })
    await expect.poll(starts, { timeout: 15_000 }).toEqual(['unset e2e-idle', 'unset e2e-busy'])

    await win.locator('.topbar').getByRole('button', { name: 'Claude accounts' }).click()
    await win.getByText('Manage accounts…').click()
    const settings = win.getByRole('region', { name: 'Settings' })
    const row = settings
      .getByRole('list', { name: 'Claude accounts' })
      .getByRole('listitem')
      .filter({ hasText: EMAIL })
    await row.getByRole('button', { name: `Switch to ${EMAIL}` }).click()
    await expect(row).toContainText('Active')

    await expect
      .poll(starts, { timeout: 60_000 })
      .toEqual(['unset e2e-idle', 'unset e2e-busy', `${profile} e2e-idle`])
    await expectHeld(async () => starts().length, 3, 1500)

    writeFileSync(gate, '')
    await expect
      .poll(starts, { timeout: 60_000 })
      .toEqual(['unset e2e-idle', 'unset e2e-busy', `${profile} e2e-idle`, `${profile} e2e-busy`])
  } finally {
    await app.close()
  }
})
