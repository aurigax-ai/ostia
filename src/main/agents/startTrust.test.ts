import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPane, removePane } from '../control/idRegistry'
import { removeWorkspace, setWorkspaceWorkDir } from '../workspaces/workspaceRegistry'
import { createOutsideTrust, createStartTrust } from './startTrust'

let home: string
let project: string
let scratchDir: string
let profile: string
let defaultConfig: string
let profileConfig: string
let switchOn: unknown
const ptys = new Map<string, unknown>()
const scratch = new Set<string>()
const sandboxed = new Set<string>()
const WORKSPACES = ['ws', 'scratch', 'sandbox']
const EMPTY = '{"projects":{}}\n'

function pane(paneId: string, workspaceId: string, host = hostname(), path = project) {
  const identity = registerPane({ windowId: '1', workspaceId, paneId })
  ptys.set(paneId, { mirror: { cwdReport: { host, path } } })
  return identity
}

const startTrust = createStartTrust({
  ptys: ptys as never,
  scratchFolders: {
    isScratch: (id) => scratch.has(id ?? ''),
    dirOf: (id) => (scratch.has(id ?? '') ? scratchDir : null),
  },
  workspaceSandboxes: { isEnabled: (id) => sandboxed.has(id) },
  readSettingsFile: () => ({ agents: { trustWorkspaceFolders: switchOn } }),
})

const trustedIn = (file: string, folder: string): unknown =>
  JSON.parse(readFileSync(file, 'utf8')).projects?.[folder]?.hasTrustDialogAccepted

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-start-trust-')))
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  switchOn = false
  project = join(home, 'work', 'shop')
  scratchDir = join(home, 'scratch', '1-abc')
  mkdirSync(project, { recursive: true })
  mkdirSync(scratchDir, { recursive: true })
  defaultConfig = join(home, '.claude.json')
  writeFileSync(defaultConfig, EMPTY)
  profile = join(home, 'accounts', 'work')
  mkdirSync(profile, { recursive: true })
  profileConfig = join(profile, '.claude.json')
  writeFileSync(profileConfig, EMPTY)
  for (const id of WORKSPACES) setWorkspaceWorkDir(id, project)
  scratch.add('scratch')
  sandboxed.add('sandbox')
})

afterEach(() => {
  for (const id of ptys.keys()) removePane(id)
  ptys.clear()
  scratch.clear()
  sandboxed.clear()
  for (const id of WORKSPACES) removeWorkspace(id)
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('carrying trust into an account profile', () => {
  it('CFT-C49 copies the Default account’s trust of the folder the pane’s shell reports', async () => {
    writeFileSync(
      defaultConfig,
      JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }),
    )
    expect(await startTrust(profile, pane('p-ok', 'ws'))).toBe(true)
    expect(trustedIn(profileConfig, project)).toBe(true)
  })

  it('CFT-C50 asks again in a folder the Default account does not trust', async () => {
    const other = join(home, 'work', 'other')
    mkdirSync(other)
    expect(await startTrust(profile, pane('p-new', 'ws', hostname(), other))).toBe(false)
    expect(readFileSync(profileConfig, 'utf8')).toBe(EMPTY)
  })

  it('CFT-C51 refuses sandboxed, manager, remote and unknown panes, and writes nothing', async () => {
    writeFileSync(
      defaultConfig,
      JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }),
    )
    const manager = pane('p-manager', 'ws')
    manager.manager = true
    const silent = registerPane({ windowId: '1', workspaceId: 'ws', paneId: 'p-silent' })
    for (const identity of [
      pane('p-sandbox', 'sandbox'),
      manager,
      pane('p-remote', 'ws', 'some-other-host'),
      silent,
    ])
      expect(await startTrust(profile, identity)).toBe(false)
    expect(readFileSync(profileConfig, 'utf8')).toBe(EMPTY)
  })

  it('CFT-C52 refuses a pane whose folder is home', async () => {
    writeFileSync(
      defaultConfig,
      JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: true } } }),
    )
    expect(await startTrust(profile, pane('p-home', 'ws', hostname(), home))).toBe(false)
    expect(readFileSync(profileConfig, 'utf8')).toBe(EMPTY)
  })
})

describe('trusting the workspace folder while agents.trustWorkspaceFolders is on', () => {
  beforeEach(() => {
    switchOn = true
  })

  it('CFT-C53 trusts the workspace folder in the Default config when the Default account starts', async () => {
    expect(await startTrust('', pane('p-ok', 'ws'))).toBe(true)
    expect(trustedIn(defaultConfig, project)).toBe(true)
    expect(readFileSync(profileConfig, 'utf8')).toBe(EMPTY)
  })

  it('CFT-C54 trusts it in the profile of the account the session uses, never in the Default config', async () => {
    expect(await startTrust(profile, pane('p-ok', 'ws'))).toBe(true)
    expect(trustedIn(profileConfig, project)).toBe(true)
    expect(readFileSync(defaultConfig, 'utf8')).toBe(EMPTY)
  })

  it('CFT-C55 trusts a subfolder of the workspace folder but not a repository root above it', async () => {
    const sub = join(project, 'pkg')
    mkdirSync(sub)
    expect(await startTrust('', pane('p-sub', 'ws', hostname(), sub))).toBe(true)
    expect(trustedIn(defaultConfig, sub)).toBe(true)
    const repo = join(home, 'mono')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const pkg = join(repo, 'pkg')
    mkdirSync(pkg)
    setWorkspaceWorkDir('ws', pkg)
    expect(await startTrust('', pane('p-above', 'ws', hostname(), pkg))).toBe(false)
    expect(trustedIn(defaultConfig, repo)).toBeUndefined()
  })

  it('CFT-C56 trusts a scratch workspace’s own folder and its subfolders, in the Default config', async () => {
    expect(await startTrust('', pane('p-scratch', 'scratch', hostname(), scratchDir))).toBe(true)
    expect(trustedIn(defaultConfig, scratchDir)).toBe(true)
    const sub = join(scratchDir, 'run')
    mkdirSync(sub)
    expect(await startTrust('', pane('p-scratch-sub', 'scratch', hostname(), sub))).toBe(true)
    expect(trustedIn(defaultConfig, sub)).toBeUndefined()
  })

  it('CFT-C57 refuses a scratch pane that left its folder', async () => {
    expect(await startTrust('', pane('p-out', 'scratch', hostname(), project))).toBe(false)
    expect(trustedIn(defaultConfig, project)).toBeUndefined()
  })

  it('CFT-C58 refuses home, /, sandboxed, manager, remote and unknown panes, and writes nothing', async () => {
    const manager = pane('p-manager', 'ws')
    manager.manager = true
    const silent = registerPane({ windowId: '1', workspaceId: 'ws', paneId: 'p-silent' })
    for (const identity of [
      pane('p-home', 'ws', hostname(), home),
      pane('p-root', 'ws', hostname(), '/'),
      pane('p-sandbox', 'sandbox'),
      manager,
      pane('p-remote', 'ws', 'some-other-host'),
      silent,
    ])
      expect(await startTrust('', identity)).toBe(false)
    expect(readFileSync(defaultConfig, 'utf8')).toBe(EMPTY)
    expect(readFileSync(profileConfig, 'utf8')).toBe(EMPTY)
  })

  it('CFT-C59 never creates Claude’s config', async () => {
    rmSync(defaultConfig)
    expect(await startTrust('', pane('p-ok', 'ws'))).toBe(false)
    expect(() => readFileSync(defaultConfig)).toThrow()
  })
})

describe('with agents.trustWorkspaceFolders off', () => {
  it.each([[false], [undefined], ['true'], [1]])(
    'CFT-C60 writes no trust without the carry when the setting is %s',
    async (value) => {
      switchOn = value
      expect(await startTrust('', pane('p-ok', 'ws'))).toBe(false)
      expect(await startTrust('', pane('p-scratch', 'scratch', hostname(), scratchDir))).toBe(false)
      expect(await startTrust(profile, pane('p-work', 'ws'))).toBe(false)
      expect(readFileSync(defaultConfig, 'utf8')).toBe(EMPTY)
      expect(readFileSync(profileConfig, 'utf8')).toBe(EMPTY)
    },
  )
})

describe('createOutsideTrust with an extra account current', () => {
  let current = ''
  const outside = createOutsideTrust({
    scratchFolders: { isScratch: () => false, dirOf: () => null },
    workspaceSandboxes: { isEnabled: () => false },
    readSettingsFile: () => ({ agents: { trustWorkspaceFolders: true } }),
    claudeAccounts: { currentDirectory: () => current },
  })
  const accepted = (other: string) =>
    `${JSON.stringify({ projects: { [other]: { hasTrustDialogAccepted: true } } })}\n`

  it('CFT-C65 reads the current account’s config, not the Default one', async () => {
    const other = join(home, 'other')
    mkdirSync(other)
    current = profile
    writeFileSync(defaultConfig, accepted(other))
    expect(await outside('ws', other)).toBe(other)
    writeFileSync(profileConfig, accepted(other))
    expect(await outside('ws', other)).toBeNull()
    current = ''
    expect(await outside('ws', other)).toBeNull()
    writeFileSync(defaultConfig, EMPTY)
    expect(await outside('ws', other)).toBe(other)
  })
})
