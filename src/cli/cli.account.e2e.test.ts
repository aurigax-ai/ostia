import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../shared/control/commands'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { registerControlServer, stopControlServer } = await import('../main/control/controlServer')
const { registerPane, removePane } = await import('../main/control/idRegistry')
const { grant, revoke } = await import('../main/approvals/capabilityStore')
const { ClaudeAccountsStore } = await import('../main/agents/claudeAccounts/accountsStore')
const { ClaudeAccounts } = await import('../main/agents/claudeAccounts/claudeAccounts')
const { registerClaudeAccountsWiring } = await import(
  '../main/agents/claudeAccounts/claudeAccountsWiring'
)

const WORK = 'a'.repeat(16)
const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const pane = registerPane({ windowId: '7', workspaceId: 'ws1', paneId: 'account-pane' })

let base = ''
let socketPath = ''
let store: InstanceType<typeof ClaudeAccountsStore>

function ostia(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, OSTIA_SOCKET: socketPath, OSTIA_TOKEN: pane.token },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-cli-account-'))
  store = new ClaudeAccountsStore(join(base, 'accounts.json'))
  store.add({ id: WORK, email: 'work@example.com', addedAt: 1 })
  registerClaudeAccountsWiring({
    claudeAccounts: new ClaudeAccounts({
      store,
      root: join(base, 'profiles'),
      defaultHome: () => join(base, 'home'),
      defaultEmail: async () => 'me@example.com',
      profileEmail: async () => null,
      openLoginTab: async () => null,
      onChange: () => {},
    }),
    agentResumes: { subscribe: () => {} } as never,
    workspaceSandboxes: { isEnabled: () => false },
  })
})

beforeEach(() => {
  socketPath = join(tmpdir(), `ostia-cli-account-${process.pid}.sock`)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
    },
    socketPath,
  )
})

afterEach(() => {
  revoke(pane.externalId, 'settings-write')
  stopControlServer()
})

afterAll(() => {
  removePane(pane.paneId)
  rmSync(base, { recursive: true, force: true })
})

describe('ostia account (the real CLI against a live control server)', () => {
  it('lists every account with its number, email and the current one', async () => {
    const res = await ostia(['account', 'list'])
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('1\tme@example.com\tcurrent\n2\twork@example.com\t\n')
    const json = JSON.parse((await ostia(['account', 'list', '--json'])).stdout)
    expect(json.accounts).toEqual([
      { number: 1, email: 'me@example.com', current: true },
      { number: 2, email: 'work@example.com', current: false },
    ])
  })

  it('holds a switch until the human approves settings-write, then switches new sessions', async () => {
    const held = await ostia(['account', 'switch', '2'])
    expect(held.code).not.toBe(0)
    expect(held.stderr).toContain('needs-elevation: settings-write')
    expect(store.current()).toBe('default')

    grant(pane.externalId, 'settings-write')
    const done = await ostia(['account', 'switch', 'work@example.com'])
    expect(done.code).toBe(0)
    expect(done.stdout).toBe('2\twork@example.com\n')
    expect(store.current()).toBe(WORK)
    store.use('default')
  })

  it('names an unknown account and the command to list them', async () => {
    grant(pane.externalId, 'settings-write')
    const res = await ostia(['account', 'switch', '9'])
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('ostia account switch: unknown-account')
    expect(res.stderr).toContain('ostia account list')
  })

  it('answers a Claude start with the profile folder of the current account, and nothing for the default', async () => {
    expect((await ostia(['claude-account', 'start', '--', '--help'])).stdout).toBe('')
    store.use(WORK)
    const res = await ostia(['claude-account', 'start', '--', '--model', 'opus'])
    expect(res.stdout).toBe(`${join(base, 'profiles', WORK)}\n`)
    store.use('default')
  })
})
