import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOM_RENDERER_SETTINGS,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
  testHome,
} from './dataHome'
import { REPORT_SESSION } from './fakeAgent'
import { typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 90_000 })

const FAKE_CLAUDE = [
  '#!/bin/sh',
  'if grep -A1 "\\"$PWD\\"" "$HOME/.claude.json" | grep -q hasTrustDialogAccepted; then',
  `  ${REPORT_SESSION}`,
  '  echo fake-agent-ready',
  'else',
  '  echo trust-dialog-shown',
  'fi',
  'exec cat',
  '',
].join('\n')

test('CFT-C61 ostia agent run starts Claude in the workspace folder with no trust dialog while agents.trustWorkspaceFolders is on', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, agents: { trustWorkspaceFolders: true } })
  const home = testHome(dataHome)
  const project = join(home, 'work', 'shop')
  mkdirSync(project, { recursive: true })
  const config = join(home, '.claude.json')
  writeFileSync(config, `${JSON.stringify({ userID: 'e2e', projects: {} }, null, 2)}\n`, {
    mode: 0o600,
  })
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  mkdirSync(join(dataHome, 'ostia'), { recursive: true })
  writeFileSync(
    join(dataHome, 'ostia', 'workspaces.json'),
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      activeWorkspaceId: 's1',
      groups: [],
      workspaces: [
        {
          id: 's1',
          name: 'shop',
          kind: 'terminal',
          workDir: project,
          root: { type: 'pane', id: 'pane-1', title: 'sh', kind: 'terminal', cwd: project },
          activePaneId: 'pane-1',
        },
      ],
    }),
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, CLAUDE_CONFIG_DIR: '', PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const caller = win.locator('.xterm-rows').first()
    await expect(caller).toContainText('❯', { timeout: 20_000 })
    await win.locator('.xterm').first().click()
    await typeLine(win, 'ostia agent run claude go --name worker; echo run-exit-$?')
    await expect(caller).toContainText('run-exit-0', { timeout: 40_000 })
    const trust = JSON.parse(readFileSync(config, 'utf8')).projects?.[project]
    expect(trust?.hasTrustDialogAccepted).toBe(true)
    await typeLine(win, 'ostia pane read worker')
    await expect(caller).toContainText('fake-agent-ready', { timeout: 15_000 })
    await expect(caller).not.toContainText('trust-dialog-shown')
  } finally {
    await app.close()
  }
})
