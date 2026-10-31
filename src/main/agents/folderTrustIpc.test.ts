import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(channel, fn),
  },
}))

const { registerPane, removePane } = await import('../control/idRegistry')
const { removeWorkspace, setWorkspaceWorkDir } = await import('../workspaces/workspaceRegistry')
const { registerFolderTrustIpc } = await import('./folderTrustIpc')

let home: string
let project: string
let config: string
const ptys = new Map<string, unknown>()
const scratch = new Set<string>()
const sandboxed = new Set<string>()

function pane(paneId: string, workspaceId: string, host = hostname(), windowId = '1') {
  const identity = registerPane({ windowId, workspaceId, paneId })
  ptys.set(paneId, { mirror: { cwdReport: { host, path: project } } })
  return identity
}

let accountDir: string | undefined

const ask = (paneId: string, sender = '1') =>
  handlers.get('agent:folder-trust')?.({ sender: { id: Number(sender) } }, paneId)
const trust = (paneId: string, sender = '1', shown = project) =>
  handlers.get('agent:trust-folder')?.({ sender: { id: Number(sender) } }, paneId, shown)

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-trust-ipc-')))
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  project = join(home, 'work', 'shop')
  mkdirSync(project, { recursive: true })
  config = join(home, '.claude.json')
  writeFileSync(config, '{"projects":{}}\n', { mode: 0o600 })
  for (const id of ['ws', 'scratch', 'sandbox']) setWorkspaceWorkDir(id, project)
  scratch.add('scratch')
  sandboxed.add('sandbox')
  registerFolderTrustIpc({
    ptys: ptys as never,
    scratchFolders: { isScratch: (id) => scratch.has(id ?? '') },
    workspaceSandboxes: { isEnabled: (id) => sandboxed.has(id) },
    readSettingsFile: () => ({}),
    claudeAccounts: { configDir: () => accountDir },
  })
})

afterEach(() => {
  for (const id of ptys.keys()) removePane(id)
  ptys.clear()
  accountDir = undefined
  for (const id of ['ws', 'scratch', 'sandbox']) removeWorkspace(id)
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('folder trust IPC', () => {
  it('CFT-C20 offers the folder of the owner window’s local pane in a plain workspace', async () => {
    pane('p-ok', 'ws')
    expect(await ask('p-ok')).toEqual({ state: 'ask', folder: project })
    expect(await trust('p-ok')).toBe(true)
    expect(JSON.parse(readFileSync(config, 'utf8')).projects[project]).toEqual({
      hasTrustDialogAccepted: true,
    })
  })

  it('CFT-C21 refuses scratch, sandboxed, manager, remote and other windows’ panes, and writes nothing', async () => {
    pane('p-scratch', 'scratch')
    pane('p-sandbox', 'sandbox')
    pane('p-manager', 'ws').manager = true
    pane('p-remote', 'ws', 'some-other-host')
    pane('p-other', 'ws', hostname(), '2')
    for (const id of ['p-scratch', 'p-sandbox', 'p-manager', 'p-remote', 'p-other', 'p-unknown']) {
      expect(await ask(id)).toEqual({ state: 'unknown' })
      expect(await trust(id)).toBe(false)
    }
    expect(readFileSync(config, 'utf8')).toBe('{"projects":{}}\n')
  })

  it('CFT-C22 reads and writes the config in main’s CLAUDE_CONFIG_DIR, the one every pane inherits', async () => {
    pane('p-ok', 'ws')
    const profile = join(home, 'profile')
    mkdirSync(profile)
    writeFileSync(join(profile, '.claude.json'), '{"projects":{}}\n')
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile)
    expect(await trust('p-ok')).toBe(true)
    expect(
      JSON.parse(readFileSync(join(profile, '.claude.json'), 'utf8')).projects[project],
    ).toEqual({
      hasTrustDialogAccepted: true,
    })
    expect(readFileSync(config, 'utf8')).toBe('{"projects":{}}\n')
  })

  it('CFT-C35 writes the trust key into the profile of the current account, the one every start uses', async () => {
    pane('p-ok', 'ws')
    const profile = join(home, 'accounts', 'work')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, '.claude.json'), '{"projects":{}}\n')
    accountDir = profile
    expect(await ask('p-ok')).toEqual({ state: 'ask', folder: project })
    expect(await trust('p-ok')).toBe(true)
    expect(
      JSON.parse(readFileSync(join(profile, '.claude.json'), 'utf8')).projects[project],
    ).toEqual({ hasTrustDialogAccepted: true })
    expect(readFileSync(config, 'utf8')).toBe('{"projects":{}}\n')
  })

  it('CFT-C34 trusts only the folder the note showed, never one the pane moved to since', async () => {
    pane('p-ok', 'ws')
    const other = join(home, 'work', 'other')
    mkdirSync(other)
    expect(await trust('p-ok', '1', other)).toBe(false)
    expect(await handlers.get('agent:trust-folder')?.({ sender: { id: 1 } }, 'p-ok')).toBe(false)
    expect(readFileSync(config, 'utf8')).toBe('{"projects":{}}\n')
  })
})
