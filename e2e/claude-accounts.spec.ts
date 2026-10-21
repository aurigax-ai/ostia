import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 120_000 })

const EMAIL = 'work@e2e.test'

const FAKE_CLAUDE = [
  '#!/bin/sh',
  'if [ -z "$CLAUDE_CONFIG_DIR" ]; then echo "fake-claude dir=unset"; exec cat; fi',
  'if [ ! -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then',
  `  printf '%s' '{"oauthAccount":{"emailAddress":"${EMAIL}"}}' > "$CLAUDE_CONFIG_DIR/.claude.json"`,
  '  printf x > "$CLAUDE_CONFIG_DIR/.credentials.json"',
  '  echo "fake-claude signed-in dir=$CLAUDE_CONFIG_DIR"',
  'else',
  '  echo "fake-claude dir=$CLAUDE_CONFIG_DIR"',
  'fi',
  'exec cat',
  '',
].join('\n')

test('CLA-E1 Add signs in on a new profile in a terminal tab, lists the account, and a new Claude then starts on it', async () => {
  const dataHome = freshDataHome()
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
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

    await expect(list.getByRole('listitem').filter({ hasText: EMAIL })).toBeVisible({
      timeout: 30_000,
    })
    const profiles = join(dataHome, 'ostia', 'claude-accounts')
    const [id] = readdirSync(profiles)
    const profile = join(profiles, id)
    expect(statSync(profile).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(profile, 'projects')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(profile, 'projects'))).toBe(join(launch.home, '.claude', 'projects'))
    expect(existsSync(join(dataHome, 'ostia', 'claude-accounts.json'))).toBe(true)
    expect(statSync(join(dataHome, 'ostia', 'claude-accounts.json')).mode & 0o777).toBe(0o600)

    const row = list.getByRole('listitem').filter({ hasText: EMAIL })
    await row.getByRole('button', { name: `Actions for ${EMAIL}` }).click()
    await win.getByRole('menuitem', { name: 'Switch to' }).click()
    await expect(row).toContainText('Active')

    await win.locator('.rail-tab').filter({ hasText: 'home' }).click()
    await win.locator('.xterm').first().click()
    await typeLine(win, 'claude')
    await expect(terminal).toContainText(`fake-claude dir=${profile}`, { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
