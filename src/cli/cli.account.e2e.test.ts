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
      loginState: async () => 'signed-in',
      writeLogin: async () => true,
      signIn: null,
      usage: {
        run: () => {},
        usageOf: (id) =>
          id === WORK
            ? {
                session: { percent: 42.4, resetsAt: Date.now() + 3_600_000 },
                weekly: { percent: 18, resetsAt: Date.now() + 86_400_000 * 3 },
                checkedAt: Date.now(),
              }
            : null,
      },
      syncProfile: async () => {},
      agentRunning: () => false,
      paneOf: (id) => id,
      openLoginTab: async () => null,
      onChange: () => {},
    }),
    agentResumes: { subscribe: () => {} } as never,
    workspaceSandboxes: { isEnabled: () => false },
    scratchFolders: { isScratch: () => false },
    workspaceWindowId: () => '7',
    execCommand: async () => ({ ok: true }) as CommandResult,
    trustForStart: async () => false,
    windowIds: () => ['7'],
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
  it('lists every account with its number, email, the current one and its checked usage', async () => {
    const res = await ostia(['account', 'list'])
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('1\tme@example.com\tcurrent\t\t\n2\twork@example.com\t\t42%\t18%\n')
    const json = JSON.parse((await ostia(['account', 'list', '--json'])).stdout)
    expect(json.accounts).toEqual([
      {
        number: 1,
        email: 'me@example.com',
        current: true,
        enabled: true,
        session: null,
        weekly: null,
      },
      {
        number: 2,
        email: 'work@example.com',
        current: false,
        enabled: true,
        session: 42,
        weekly: 18,
      },
    ])
  })

  it('never switches without the human’s card, not even after an Always allow of settings-write', async () => {
    const held = await ostia(['account', 'switch', '2'])
    expect(held.code).not.toBe(0)
    expect(held.stderr).toContain('ostia account switch: not-approved')
    grant(pane.externalId, 'settings-write')
    const granted = await ostia(['account', 'switch', 'work@example.com'])
    expect(granted.code).not.toBe(0)
    expect(granted.stderr).toContain('not-approved')
    expect(store.current()).toBe('default')
  })

  it('marks an account that is turned off and refuses to switch to it', async () => {
    store.setEnabled(WORK, false)
    try {
      expect((await ostia(['account', 'list'])).stdout).toContain('2\twork@example.com\toff\t')
      const res = await ostia(['account', 'switch', '2'])
      expect(res.code).not.toBe(0)
      expect(res.stderr).toContain('ostia account switch: account-off')
      expect(res.stderr).toContain('Settings › Claude accounts')
    } finally {
      store.setEnabled(WORK, true)
    }
  })

  it('names an unknown account and the command to list them', async () => {
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
