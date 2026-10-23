import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPane, removePane } from '../control/idRegistry'
import { removeWorkspace, setWorkspaceWorkDir } from '../workspaces/workspaceRegistry'
import { createTrustCarry } from './trustCarry'

let home: string
let project: string
let profile: string
let profileConfig: string
const ptys = new Map<string, unknown>()
const scratch = new Set<string>()
const sandboxed = new Set<string>()
const WORKSPACES = ['ws', 'scratch', 'sandbox']
const TRUSTED = '{"projects":{}}\n'

function pane(paneId: string, workspaceId: string, host = hostname(), path = project) {
  const identity = registerPane({ windowId: '1', workspaceId, paneId })
  ptys.set(paneId, { mirror: { cwdReport: { host, path } } })
  return identity
}

const carry = createTrustCarry({
  ptys: ptys as never,
  scratchFolders: { isScratch: (id) => scratch.has(id ?? '') },
  workspaceSandboxes: { isEnabled: (id) => sandboxed.has(id) },
})

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-trust-carry-')))
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  project = join(home, 'work', 'shop')
  mkdirSync(project, { recursive: true })
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }),
  )
  profile = join(home, 'accounts', 'work')
  mkdirSync(profile, { recursive: true })
  profileConfig = join(profile, '.claude.json')
  writeFileSync(profileConfig, TRUSTED)
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
    expect(await carry(profile, pane('p-ok', 'ws'))).toBe(true)
    expect(JSON.parse(readFileSync(profileConfig, 'utf8')).projects[project]).toEqual({
      hasTrustDialogAccepted: true,
    })
  })

  it('CFT-C50 asks again in a folder the Default account does not trust', async () => {
    const other = join(home, 'work', 'other')
    mkdirSync(other)
    expect(await carry(profile, pane('p-new', 'ws', hostname(), other))).toBe(false)
    expect(readFileSync(profileConfig, 'utf8')).toBe(TRUSTED)
  })

  it('CFT-C51 refuses scratch, sandboxed, manager, remote and unknown panes, and writes nothing', async () => {
    const manager = pane('p-manager', 'ws')
    manager.manager = true
    const silent = registerPane({ windowId: '1', workspaceId: 'ws', paneId: 'p-silent' })
    for (const identity of [
      pane('p-scratch', 'scratch'),
      pane('p-sandbox', 'sandbox'),
      manager,
      pane('p-remote', 'ws', 'some-other-host'),
      silent,
    ])
      expect(await carry(profile, identity)).toBe(false)
    expect(readFileSync(profileConfig, 'utf8')).toBe(TRUSTED)
  })

  it('CFT-C52 refuses a pane whose folder is home', async () => {
    expect(await carry(profile, pane('p-home', 'ws', hostname(), home))).toBe(false)
    expect(readFileSync(profileConfig, 'utf8')).toBe(TRUSTED)
  })
})
