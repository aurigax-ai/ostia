import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type { ApprovalOutcome } from '../shared/approvals'
import { MANAGER_CAPABILITIES } from '../shared/capabilities'
import type { CommandResult } from '../shared/types'
import type { ApprovalAsk } from './approvals'

let answer: ApprovalOutcome = 'deny'
const asked: ApprovalAsk[] = []
const request = vi.fn(async (ask: ApprovalAsk) => {
  asked.push(ask)
  return answer
})

vi.mock('./approvals', () => ({ approvals: () => ({ request }) }))

const { grant, setCaps } = await import('./capabilityStore')
const { setCapFilter } = await import('./controlAuth')
const { registerControlServer, stopControlServer } = await import('./controlServer')
const { markManager, registerExtension, registerPane } = await import('./idRegistry')
const { inputBytes, keyBytes, paneReach, registerPaneIoMethods } = await import('./paneIo')

type Identity = ReturnType<typeof registerPane>

const written: { paneId: string; data: string }[] = []
const children = new Map<string, string>()
const processes = new Map<string, string>()
const sandboxedWorkspaces = new Set<string>()
const confinedPanes = new Set<string>()
let managerInput = false

registerPaneIoMethods({
  io: {
    read: async (paneId, lines) => (paneId === 'no-pty' ? null : `screen of ${paneId} (${lines})`),
    write: (paneId, data) => {
      written.push({ paneId, data })
      return paneId !== 'no-pty'
    },
  },
  state: (paneId) =>
    paneId === 'child-pane'
      ? {
          paneId,
          generation: 1,
          cwd: '/home/u/proj',
          running: true,
          blockCount: 3,
          lastExitCode: 1,
        }
      : undefined,
  processPane: (ref) => processes.get(ref),
  isChild: (ownerPaneId, paneId) => children.get(paneId) === ownerPaneId,
  isSandboxed: (workspaceId) => sandboxedWorkspaces.has(workspaceId),
  isConfined: (paneId) => confinedPanes.has(paneId),
  managerAllowsInput: () => managerInput,
})

const agent = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'agent-pane' })
const child = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'child-pane' })
const sibling = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'sibling-pane' })
const foreign = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'foreign-pane' })
const noPty = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'no-pty' })
const manager = registerPane({ windowId: 'w1', workspaceId: 'ws-mgr', paneId: 'mgr-pane' })
markManager('mgr-pane')
const extension = registerExtension('probe')

let socketPath = ''
let seq = 0
const clients: MessageConnection[] = []
const minted: Identity[] = []

function freshPane(workspaceId: string): Identity {
  const identity = registerPane({ windowId: 'w1', workspaceId, paneId: `caller-${++seq}` })
  minted.push(identity)
  return identity
}

async function client(identity: { token: string }): Promise<MessageConnection> {
  const socket = createConnection(socketPath)
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.listen()
  clients.push(conn)
  await conn.sendRequest('hello', { token: identity.token })
  return conn
}

beforeEach(() => {
  seq += 1
  socketPath = join(tmpdir(), `ostia-pane-io-${process.pid}-${seq}.sock`)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
    },
    socketPath,
  )
  answer = 'deny'
  asked.length = 0
  request.mockClear()
  written.length = 0
  children.clear()
  children.set('child-pane', 'agent-pane')
  processes.clear()
  processes.set('echo', 'child-pane')
  sandboxedWorkspaces.clear()
  confinedPanes.clear()
  managerInput = false
  setCapFilter(() => true)
})

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
  stopControlServer()
})

const facts = (
  over: {
    caller?: Partial<{ paneId: string; workspaceId: string; sandboxed: boolean }>
    target?: Partial<{ paneId: string; workspaceId: string; manager: boolean; confined: boolean }>
    ownChild?: boolean
  } = {},
) => ({
  caller: { paneId: 'a', workspaceId: 'ws1', sandboxed: false, ...over.caller },
  target: { paneId: 'b', workspaceId: 'ws1', manager: false, confined: false, ...over.target },
  ownChild: over.ownChild ?? false,
})

describe('paneReach', () => {
  it('lets a pane type into and read a tab it opened with only the process capability', () => {
    for (const kind of ['input', 'read'] as const) {
      expect(paneReach(kind, facts({ ownChild: true }))).toEqual({
        allowed: true,
        caps: ['process'],
      })
    }
  })

  it('asks for the elevated capability for any other pane of the workspace', () => {
    expect(paneReach('input', facts())).toEqual({ allowed: true, caps: ['type-other-pane'] })
    expect(paneReach('read', facts())).toEqual({ allowed: true, caps: ['read-other-pane'] })
  })

  it('also asks for all-workspaces when the pane is in another workspace', () => {
    const other = facts({ target: { workspaceId: 'ws2' } })
    expect(paneReach('input', other)).toEqual({
      allowed: true,
      caps: ['type-other-pane', 'all-workspaces'],
    })
    expect(paneReach('read', other)).toEqual({
      allowed: true,
      caps: ['read-other-pane', 'all-workspaces'],
    })
  })

  it('stops treating a tab as its own once it moved to another workspace', () => {
    expect(paneReach('input', facts({ ownChild: true, target: { workspaceId: 'ws2' } }))).toEqual({
      allowed: true,
      caps: ['type-other-pane', 'all-workspaces'],
    })
  })

  it('never lets a sandboxed caller out of its workspace or into a host pane', () => {
    const caller = { sandboxed: true }
    expect(paneReach('read', facts({ caller, target: { workspaceId: 'ws2' } }))).toEqual({
      allowed: false,
      error: 'sandboxed',
    })
    expect(paneReach('input', facts({ caller, ownChild: true }))).toEqual({
      allowed: false,
      error: 'sandboxed',
    })
    expect(paneReach('input', facts({ caller, target: { confined: true } }))).toEqual({
      allowed: true,
      caps: ['type-other-pane'],
    })
    expect(
      paneReach('input', facts({ caller, ownChild: true, target: { confined: true } })),
    ).toEqual({ allowed: true, caps: ['process'] })
  })

  it('hides the manager pane as an unknown pane, whatever the caller holds', () => {
    for (const kind of ['input', 'read'] as const) {
      expect(paneReach(kind, facts({ ownChild: true, target: { manager: true } }))).toEqual({
        allowed: false,
        error: 'unknown-pane',
      })
    }
  })

  it('lets a pane read its own screen but never type into itself', () => {
    const self = facts({ target: { paneId: 'a' } })
    expect(paneReach('read', self)).toEqual({ allowed: true, caps: [] })
    expect(paneReach('input', self)).toEqual({ allowed: false, error: 'own-pane' })
  })
})

describe('input keys', () => {
  it('maps named keys, aliases and control letters to their bytes', () => {
    expect(keyBytes('Enter')).toBe('\r')
    expect(keyBytes('return')).toBe('\r')
    expect(keyBytes('esc')).toBe('\x1b')
    expect(keyBytes('ctrl+c')).toBe('\x03')
    expect(keyBytes('ctrl-z')).toBe('\x1a')
    expect(keyBytes('shift+tab')).toBe('\x1b[Z')
    expect(keyBytes('constructor')).toBeUndefined()
    expect(keyBytes('f13')).toBeUndefined()
  })

  it('joins text and keys in order and refuses nothing, junk and oversized input', () => {
    expect(inputBytes('y', ['enter'])).toBe('y\r')
    expect(() => inputBytes(undefined, undefined)).toThrow('bad-request: text or keys')
    expect(() => inputBytes('x', ['nope'])).toThrow('unknown-key: nope')
    expect(() => inputBytes('x'.repeat(16 * 1024 + 1), undefined)).toThrow('too-long')
  })
})

describe('pane.input', () => {
  it('types text and keys into a tab the caller opened, by process name, without asking', async () => {
    const conn = await client(agent)
    await expect(
      conn.sendRequest('pane.input', { pane: 'echo', text: 'hello world', keys: ['enter'] }),
    ).resolves.toEqual({ ok: true, paneId: child.externalId })
    expect(written).toEqual([{ paneId: 'child-pane', data: 'hello world\r' }])
    expect(request).not.toHaveBeenCalled()
  })

  it('asks the human before typing into a pane the caller did not open, and stops on Deny', async () => {
    const conn = await client(agent)
    await expect(
      conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'rm -rf /' }),
    ).rejects.toThrow('denied: type-other-pane')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      externalId: agent.externalId,
      paneId: 'agent-pane',
      caps: ['type-other-pane'],
      action: 'pane.input',
    })
    expect(asked[0].detail).toContain('"rm -rf /"')
    expect(written).toEqual([])
  })

  it('types once the human allows it', async () => {
    answer = 'once'
    const conn = await client(agent)
    await conn.sendRequest('pane.input', { pane: sibling.externalId, keys: ['ctrl-c'] })
    expect(written).toEqual([{ paneId: 'sibling-pane', data: '\x03' }])
  })

  it('does not ask a pane the human already granted the capability', async () => {
    const caller = freshPane('ws1')
    const conn = await client(caller)
    grant(caller.externalId, 'type-other-pane')
    await conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'ls' })
    expect(request).not.toHaveBeenCalled()
    expect(written).toEqual([{ paneId: 'sibling-pane', data: 'ls' }])
  })

  it('needs all-workspaces as well for a pane in another workspace', async () => {
    const conn = await client(agent)
    await expect(
      conn.sendRequest('pane.input', { pane: foreign.externalId, text: 'x' }),
    ).rejects.toThrow('denied: type-other-pane, all-workspaces')
    expect(asked[0].caps).toEqual(['type-other-pane', 'all-workspaces'])
  })

  it('refuses a sandboxed caller outside its workspace and at a host pane without a card', async () => {
    sandboxedWorkspaces.add('ws1')
    const caller = freshPane('ws1')
    const conn = await client(caller)
    grant(caller.externalId, 'type-other-pane')
    grant(caller.externalId, 'all-workspaces')
    for (const pane of [foreign.externalId, sibling.externalId]) {
      await expect(conn.sendRequest('pane.input', { pane, text: 'x' })).rejects.toThrow(
        'sandboxed:',
      )
    }
    confinedPanes.add('sibling-pane')
    await conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'x' })
    expect(written).toEqual([{ paneId: 'sibling-pane', data: 'x' }])
    expect(request).not.toHaveBeenCalled()
  })

  it('answers unknown-pane for the manager pane, as for a pane that does not exist', async () => {
    answer = 'once'
    const conn = await client(agent)
    for (const pane of [manager.externalId, 'nope']) {
      await expect(conn.sendRequest('pane.input', { pane, text: 'x' })).rejects.toThrow(
        `unknown-pane: ${pane}`,
      )
    }
    expect(request).not.toHaveBeenCalled()
    expect(written).toEqual([])
  })

  it('refuses a pane typing into itself and a pane without a terminal', async () => {
    const conn = await client(agent)
    await expect(
      conn.sendRequest('pane.input', { pane: agent.externalId, text: 'x' }),
    ).rejects.toThrow('own-pane')
    answer = 'once'
    await expect(
      conn.sendRequest('pane.input', { pane: noPty.externalId, text: 'x' }),
    ).rejects.toThrow('no-terminal')
  })

  it('holds the manager to manager.allowInput', async () => {
    setCaps(manager.externalId, MANAGER_CAPABILITIES)
    const conn = await client(manager)
    await expect(
      conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'y' }),
    ).rejects.toThrow('input-off')
    expect(written).toEqual([])
    managerInput = true
    await conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'y' })
    expect(written).toEqual([{ paneId: 'sibling-pane', data: 'y' }])
  })

  it('is not available to extensions, with or without a target pane', async () => {
    setCaps(extension.externalId, ['process', 'all-workspaces', 'type-other-pane'])
    const conn = await client(extension)
    for (const method of ['pane.input', 'pane.read']) {
      await expect(
        conn.sendRequest(method, {
          pane: sibling.externalId,
          text: 'x',
          targetPaneId: agent.externalId,
        }),
      ).rejects.toThrow('not-available-to-extension')
    }
    expect(written).toEqual([])
  })
})

describe('pane.read', () => {
  it('returns the screen and command state of a tab the caller opened', async () => {
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.read', { pane: 'echo', lines: 99999 })).resolves.toEqual({
      paneId: child.externalId,
      text: 'screen of child-pane (2000)',
      cwd: '/home/u/proj',
      running: true,
      lastExitCode: 1,
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('asks before reading another pane and returns nothing on Deny', async () => {
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.read', { pane: sibling.externalId })).rejects.toThrow(
      'denied: read-other-pane',
    )
    expect(asked[0]).toMatchObject({ caps: ['read-other-pane'], action: 'pane.read' })
  })

  it('reads another pane once allowed, 200 lines by default', async () => {
    answer = 'once'
    const conn = await client(agent)
    await expect(
      conn.sendRequest('pane.read', { pane: sibling.externalId }),
    ).resolves.toMatchObject({ text: 'screen of sibling-pane (200)', running: false })
  })

  it('keeps typing and reading as separate grants', async () => {
    const caller = freshPane('ws1')
    const conn = await client(caller)
    grant(caller.externalId, 'read-other-pane')
    await conn.sendRequest('pane.read', { pane: sibling.externalId })
    await expect(
      conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'x' }),
    ).rejects.toThrow('denied: type-other-pane')
  })

  it('lets a pane read its own screen', async () => {
    const conn = await client(agent)
    await expect(
      conn.sendRequest('pane.read', { pane: agent.externalId, lines: 5 }),
    ).resolves.toMatchObject({ text: 'screen of agent-pane (5)' })
    expect(request).not.toHaveBeenCalled()
  })
})
