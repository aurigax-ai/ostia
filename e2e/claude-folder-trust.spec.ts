import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DOM_RENDERER_SETTINGS,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
  testHome,
} from './dataHome'
import { typeLine } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

test.describe.configure({ timeout: 90_000 })

const RESUME_ID = 'e2e-trust-4242'
const SHOWN_ROWS =
  '.workzone-workspace:not([data-hidden]) .pane-slot:not([data-hidden]) .xterm-rows'

interface Setup {
  dataHome: string
  project: string
  config: string
  log: string
}

function setup(trustWorkspaceFolders: boolean, resuming = true): Setup {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    agents: { autoResume: true, trustWorkspaceFolders },
  })
  const project = join(testHome(dataHome), 'work', 'shop')
  mkdirSync(project, { recursive: true })
  const configDir = join(dataHome, 'claude-config')
  mkdirSync(configDir, { recursive: true })
  const config = join(configDir, '.claude.json')
  writeFileSync(config, `${JSON.stringify({ userID: 'e2e', projects: {} }, null, 2)}\n`, {
    mode: 0o600,
  })
  const log = join(dataHome, 'resumed.log')
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'claude'),
    ['#!/bin/sh', `echo "fake-agent-resumed $*" | tee -a '${log}'`, 'exec cat', ''].join('\n'),
  )
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
          root: {
            type: 'pane',
            id: 'pane-1',
            title: 'claude',
            kind: 'terminal',
            cwd: project,
            ...(resuming
              ? { resume: { agent: 'claude', id: RESUME_ID, cwd: project }, agentRunning: true }
              : {}),
          },
          activePaneId: 'pane-1',
        },
      ],
    }),
  )
  return { dataHome, project, config, log }
}

async function launch(s: Setup): Promise<{ app: ElectronApplication; win: Page }> {
  const launch = isolatedLaunch(s.dataHome)
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      PATH: `${join(s.dataHome, 'bin')}:${launch.env.PATH}`,
      CLAUDE_CONFIG_DIR: join(s.dataHome, 'claude-config'),
    },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

function trusted(s: Setup): unknown {
  return JSON.parse(readFileSync(s.config, 'utf8')).projects?.[s.project]?.hasTrustDialogAccepted
}

const resumes = (s: Setup) =>
  existsSync(s.log) ? readFileSync(s.log, 'utf8').split('fake-agent-resumed').length - 1 : 0

test('CFT-C17 an untrusted workspace folder holds the resume on a note until the human trusts it for Claude', async () => {
  const s = setup(false)
  const { app, win } = await launch(s)
  try {
    const note = win.getByRole('region', { name: 'Claude folder trust' })
    await expect(note).toContainText(s.project, { timeout: 20_000 })
    expect(resumes(s)).toBe(0)
    expect(trusted(s)).toBeUndefined()
    await note.getByRole('button', { name: 'Trust folder', exact: true }).click()
    await expect(win.locator(SHOWN_ROWS)).toContainText(
      new RegExp(`fake-agent-resumed .*--resume ${RESUME_ID}`),
      {
        timeout: 15_000,
      },
    )
    expect(trusted(s)).toBe(true)
    expect(JSON.parse(readFileSync(s.config, 'utf8')).userID).toBe('e2e')
    await expect(note).toHaveCount(0)
    expect(resumes(s)).toBe(1)
  } finally {
    await app.close()
  }
})

test('CFT-C18 with the setting on, the folder is trusted and the resume goes on with no note', async () => {
  const s = setup(true)
  const { app, win } = await launch(s)
  try {
    await expect(win.locator(SHOWN_ROWS)).toContainText(
      new RegExp(`fake-agent-resumed .*--resume ${RESUME_ID}`),
      {
        timeout: 20_000,
      },
    )
    expect(trusted(s)).toBe(true)
    await expect(win.getByRole('region', { name: 'Claude folder trust' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('CFT-C64 agent run answers folder-not-trusted at once for Claude outside the workspace folder, starting nothing', async () => {
  const s = setup(true, false)
  const outside = join(dirname(s.project), 'elsewhere')
  mkdirSync(outside, { recursive: true })
  const { app, win } = await launch(s)
  try {
    await expect(win.locator(SHOWN_ROWS)).toContainText('❯', { timeout: 20_000 })
    await win.locator('.xterm').first().click()
    await typeLine(win, `ostia agent run claude hi --cwd '${outside}'; echo ran-$?`)
    await expect(win.locator(SHOWN_ROWS)).toContainText(
      `folder-not-trusted: ${outside} is outside the workspace folder`,
      { timeout: 30_000 },
    )
    await expect(win.locator(SHOWN_ROWS)).toContainText('ran-')
    expect(resumes(s)).toBe(0)
    expect(trusted(s)).toBeUndefined()
  } finally {
    await app.close()
  }
})
