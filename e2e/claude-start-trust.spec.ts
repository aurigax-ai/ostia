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
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

test.describe.configure({ timeout: 90_000 })

const CARD = 'Claude folder trust'
const SHOWN_ROWS =
  '.workzone-workspace:not([data-hidden]) .pane-slot:not([data-hidden]) .xterm-rows'

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

interface Setup {
  app: ElectronApplication
  win: Page
  project: string
  outside: string
  config: string
}

async function launch(trustWorkspaceFolders: boolean): Promise<Setup> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, agents: { trustWorkspaceFolders } })
  const home = testHome(dataHome)
  const project = join(home, 'work', 'shop')
  const outside = join(home, 'work', 'elsewhere')
  mkdirSync(project, { recursive: true })
  mkdirSync(outside, { recursive: true })
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
          anchored: true,
          root: { type: 'pane', id: 'pane-1', title: 'sh', kind: 'terminal', cwd: project },
          activePaneId: 'pane-1',
        },
      ],
    }),
  )
  const launched = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launched,
    env: { ...launched.env, CLAUDE_CONFIG_DIR: '', PATH: `${bin}:${launched.env.PATH}` },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(win.locator('.xterm-rows').first()).toContainText('❯', { timeout: 20_000 })
  await win.locator('.xterm').first().click()
  return { app, win, project, outside, config }
}

const trustOf = (s: Setup, folder: string): unknown =>
  JSON.parse(readFileSync(s.config, 'utf8')).projects?.[folder]?.hasTrustDialogAccepted

test('CFT-C61 ostia agent run starts Claude in the workspace folder with no trust dialog while agents.trustWorkspaceFolders is on', async () => {
  const s = await launch(true)
  try {
    const caller = s.win.locator(SHOWN_ROWS)
    await typeLine(s.win, 'ostia agent run claude go --name worker; echo run-exit-$?')
    await expect(caller).toContainText('run-exit-0', { timeout: 40_000 })
    expect(trustOf(s, s.project)).toBe(true)
    await typeLine(s.win, 'ostia pane read worker')
    await expect(caller).toContainText('fake-agent-ready', { timeout: 15_000 })
    await expect(caller).not.toContainText('trust-dialog-shown')
    await expect(s.win.getByRole('region', { name: CARD })).toHaveCount(0)
  } finally {
    await s.app.close()
  }
})

test('CFT-C86 ostia agent run outside the workspace folder shows the card for that exact folder and waits; Trust writes only that folder and the run goes on', async () => {
  const s = await launch(true)
  try {
    const caller = s.win.locator(SHOWN_ROWS)
    await typeLine(
      s.win,
      `ostia agent run claude go --name worker --cwd '${s.outside}'; echo run-exit-$?`,
    )
    const workerTab = s.win.getByRole('tab', { name: /worker/ })
    await workerTab.click({ timeout: 30_000 })
    const card = s.win.getByRole('region', { name: CARD })
    await expect(card).toContainText(s.outside, { timeout: 30_000 })
    await expect(card).toContainText('outside your workspace folder')
    await expect(card.getByRole('button', { name: 'More ways to trust' })).toHaveCount(0)
    expect(trustOf(s, s.outside)).toBeUndefined()
    await card.getByRole('button', { name: 'Trust folder' }).click()
    await s.win.getByRole('tab').first().click()
    await expect(caller).toContainText('run-exit-0', { timeout: 40_000 })
    expect(trustOf(s, s.outside)).toBe(true)
    expect(trustOf(s, s.project)).toBeUndefined()
    await typeLine(s.win, 'ostia pane read worker')
    await expect(caller).toContainText('fake-agent-ready', { timeout: 15_000 })
    await expect(caller).not.toContainText('trust-dialog-shown')
  } finally {
    await s.app.close()
  }
})

test('CFT-C87 Let Claude ask on the outside card starts Claude with no trust written', async () => {
  const s = await launch(true)
  try {
    const caller = s.win.locator(SHOWN_ROWS)
    await typeLine(
      s.win,
      `ostia agent run claude go --name worker --cwd '${s.outside}'; echo run-exit-$?`,
    )
    await s.win.getByRole('tab', { name: /worker/ }).click({ timeout: 30_000 })
    const card = s.win.getByRole('region', { name: CARD })
    await expect(card).toContainText(s.outside, { timeout: 30_000 })
    await card.getByRole('button', { name: 'Let Claude ask' }).click()
    await expect(caller).toContainText('trust-dialog-shown', { timeout: 20_000 })
    await expect(card).toHaveCount(0)
    expect(trustOf(s, s.outside)).toBeUndefined()
  } finally {
    await s.app.close()
  }
})

test('CFT-C88 a typed claude in an untrusted workspace folder shows the card first; Trust starts Claude with no dialog', async () => {
  const s = await launch(false)
  try {
    const caller = s.win.locator(SHOWN_ROWS)
    await typeLine(s.win, 'claude')
    const card = s.win.getByRole('region', { name: CARD })
    await expect(card).toContainText(s.project, { timeout: 30_000 })
    await expect(card.getByRole('button', { name: 'More ways to trust' })).toBeVisible()
    await expect(caller).not.toContainText('trust-dialog-shown')
    expect(trustOf(s, s.project)).toBeUndefined()
    await card.getByRole('button', { name: 'Trust folder', exact: true }).click()
    await expect(caller).toContainText('fake-agent-ready', { timeout: 20_000 })
    await expect(caller).not.toContainText('trust-dialog-shown')
    expect(trustOf(s, s.project)).toBe(true)
    await expect(card).toHaveCount(0)
  } finally {
    await s.app.close()
  }
})

test('CFT-C89 with agents.trustWorkspaceFolders on, a typed claude inside the workspace folder starts with no card, and one outside it shows the card', async () => {
  const s = await launch(true)
  try {
    const caller = s.win.locator(SHOWN_ROWS)
    await typeLine(s.win, 'claude')
    await expect(caller).toContainText('fake-agent-ready', { timeout: 20_000 })
    await expect(s.win.getByRole('region', { name: CARD })).toHaveCount(0)
    expect(trustOf(s, s.project)).toBe(true)
    await s.win.keyboard.press('Control+C')
    await typeLine(s.win, `cd '${s.outside}'`)
    await expect(caller).toContainText('elsewhere ❯', { timeout: 15_000 })
    await typeLine(s.win, 'claude')
    const card = s.win.getByRole('region', { name: CARD })
    await expect(card).toContainText(s.outside, { timeout: 30_000 })
    await expect(card).toContainText('outside your workspace folder')
    expect(trustOf(s, s.outside)).toBeUndefined()
    await card.getByRole('button', { name: 'Let Claude ask' }).click()
    await expect(caller).toContainText('trust-dialog-shown', { timeout: 20_000 })
    expect(trustOf(s, s.outside)).toBeUndefined()
  } finally {
    await s.app.close()
  }
})
