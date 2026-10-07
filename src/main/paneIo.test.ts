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
const { setCapFilter, setScriptTokenCheck } = await import('./controlAuth')
const { registerControlServer, stopControlServer } = await import('./controlServer')
const { markManager, registerExtension, registerPane } = await import('./idRegistry')
const { inputBytes, keyBytes, paneReach, pasteBytes, registerPaneIoMethods } = await import(
  './paneIo'
)
const { pastedText } = await import('./paneIo')
const { PaneWaking } = await import('./paneWaking')

type Identity = ReturnType<typeof registerPane>

const written: { paneId: string; data: string }[] = []
const children = new Map<string, string>()
const processes = new Map<string, string>()
const scopedWorkspaces = new Set<string>()
const sandboxedWorkspaces = new Set<string>()
const confinedPanes = new Set<string>()
const pasteMode = new Set<string>()
const attentionOf = new Map<string, { state?: string; message?: string }>()
const typedInto: string[] = []
const asleepPanes = new Set<string>()
const woken: string[] = []
const closed: string[] = []
const lockedPanes = new Set<string>()
const delays: number[] = []
let cursor = 0
let echoes = true
let managerInput = false
const waking = new PaneWaking()

registerPaneIoMethods({
  io: {
    read: async (paneId, lines) => (paneId === 'no-pty' ? null : `screen of ${paneId} (${lines})`),
    write: (paneId, data) => {
      written.push({ paneId, data })
      if (echoes) cursor += data.length
      return paneId !== 'no-pty'
    },
    bracketedPaste: (paneId) => pasteMode.has(paneId),
    outputCursor: (paneId) => (paneId === 'no-pty' ? undefined : cursor),
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
  processPane: async (ref) => processes.get(ref),
  inScope: async (ctx, workspaceId) =>
    ctx.identity.workspaceId === workspaceId || scopedWorkspaces.has(workspaceId),
  isChild: (ownerPaneId, paneId) => children.get(paneId) === ownerPaneId,
  isSandboxed: (workspaceId) => sandboxedWorkspaces.has(workspaceId),
  isConfined: (paneId) => confinedPanes.has(paneId),
  managerAllowsInput: () => managerInput,
  attention: async (pane) => attentionOf.get(pane.paneId) ?? {},
  inputSent: (pane) => {
    typedInto.push(pane.paneId)
  },
  hibernated: async (pane) => asleepPanes.has(pane.paneId),
  wake: async (pane) => {
    woken.push(pane.paneId)
    return asleepPanes.delete(pane.paneId)
  },
  waking,
  close: async (pane) => {
    if (lockedPanes.has(pane.paneId)) {
      return { ok: false, error: { code: 'command-failed', message: 'pane-locked: locked' } }
    }
    closed.push(pane.paneId)
    return { ok: true, result: undefined }
  },
  delay: async (ms) => {
    delays.push(ms)
  },
})

const agent = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'agent-pane' })
const child = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'child-pane' })
const sibling = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'sibling-pane' })
const foreign = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'foreign-pane' })
const noPty = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'no-pty' })
const manager = registerPane({ windowId: 'w1', workspaceId: 'ws-mgr', paneId: 'mgr-pane' })
markManager('mgr-pane')
const extension = registerExtension('probe')

const SCRIPT_TOKEN = 'ostia_pane-io-script'
setScriptTokenCheck((token) =>
  token === SCRIPT_TOKEN
    ? { id: 'script_pane_io', caps: ['type-other-pane', 'all-workspaces'] }
    : undefined,
)

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
      isSandboxed: () => false,
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
  pasteMode.clear()
  attentionOf.clear()
  typedInto.length = 0
  asleepPanes.clear()
  woken.length = 0
  closed.length = 0
  lockedPanes.clear()
  delays.length = 0
  cursor = 0
  echoes = true
  managerInput = false
  for (const paneId of ['child-pane', 'sibling-pane', 'foreign-pane']) waking.end(paneId, 'failed')
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
    sameScope?: boolean
  } = {},
) => ({
  caller: { paneId: 'a', workspaceId: 'ws1', sandboxed: false, ...over.caller },
  target: { paneId: 'b', workspaceId: 'ws1', manager: false, confined: false, ...over.target },
  ownChild: over.ownChild ?? false,
  sameScope: over.sameScope ?? false,
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

  it('lets a pane move itself and asks type-other-pane to move any other pane', () => {
    expect(paneReach('move', facts({ target: { paneId: 'a' } }))).toEqual({
      allowed: true,
      caps: [],
    })
    expect(paneReach('move', facts())).toEqual({ allowed: true, caps: ['type-other-pane'] })
    expect(paneReach('move', facts({ ownChild: true }))).toEqual({
      allowed: true,
      caps: ['process'],
    })
    expect(paneReach('move', facts({ target: { workspaceId: 'ws2' } }))).toEqual({
      allowed: true,
      caps: ['type-other-pane', 'all-workspaces'],
    })
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

  it('needs no all-workspaces for a pane in the caller’s reach scope, and only process for its own tab there', () => {
    const scoped = facts({ target: { workspaceId: 'ws2' }, sameScope: true })
    expect(paneReach('input', scoped)).toEqual({ allowed: true, caps: ['type-other-pane'] })
    expect(paneReach('read', scoped)).toEqual({ allowed: true, caps: ['read-other-pane'] })
    expect(paneReach('close', scoped)).toEqual({ allowed: true, caps: ['kill-pane'] })
    expect(
      paneReach(
        'input',
        facts({ ownChild: true, target: { workspaceId: 'ws2' }, sameScope: true }),
      ),
    ).toEqual({ allowed: true, caps: ['process'] })
  })

  it('keeps a sandboxed caller and the manager pane out, even within its reach scope', () => {
    expect(
      paneReach(
        'read',
        facts({ caller: { sandboxed: true }, target: { workspaceId: 'ws2' }, sameScope: true }),
      ),
    ).toEqual({ allowed: false, error: 'sandboxed' })
    expect(
      paneReach('read', facts({ target: { workspaceId: 'ws2', manager: true }, sameScope: true })),
    ).toEqual({ allowed: false, error: 'unknown-pane' })
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
    ).resolves.toEqual({ ok: true, paneId: child.externalId, bytes: 12, pasted: false })
    expect(written).toEqual([
      { paneId: 'child-pane', data: 'hello world' },
      { paneId: 'child-pane', data: '\r' },
    ])
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

describe('pane.wake', () => {
  it('wakes a hibernated tab the caller opened, by process name, without asking or typing itself', async () => {
    asleepPanes.add('child-pane')
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.wake', { panes: ['echo'] })).resolves.toEqual({
      ok: true,
      woke: [child.externalId],
    })
    expect(woken).toEqual(['child-pane'])
    expect(written).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('answers not-hibernated for a pane that is awake and wakes none of the named panes', async () => {
    asleepPanes.add('child-pane')
    answer = 'once'
    const conn = await client(agent)
    await expect(
      conn.sendRequest('pane.wake', { panes: ['echo', sibling.externalId] }),
    ).rejects.toThrow(`not-hibernated: ${sibling.externalId}`)
    expect(woken).toEqual([])
  })

  it('asks for type-other-pane before waking a pane the caller did not open, and stops on Deny', async () => {
    asleepPanes.add('sibling-pane')
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.wake', { panes: [sibling.externalId] })).rejects.toThrow(
      'denied: type-other-pane',
    )
    expect(asked[0]).toMatchObject({ caps: ['type-other-pane'], action: 'pane.wake' })
    expect(asked[0].detail).toContain('resume command')
    expect(woken).toEqual([])
    answer = 'once'
    await conn.sendRequest('pane.wake', { panes: [sibling.externalId] })
    expect(woken).toEqual(['sibling-pane'])
  })

  it('needs all-workspaces as well for a pane in another workspace', async () => {
    asleepPanes.add('foreign-pane')
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.wake', { panes: [foreign.externalId] })).rejects.toThrow(
      'denied: type-other-pane, all-workspaces',
    )
    expect(woken).toEqual([])
  })

  it('refuses a sandboxed caller outside its workspace and at a host pane', async () => {
    sandboxedWorkspaces.add('ws1')
    asleepPanes.add('foreign-pane')
    asleepPanes.add('sibling-pane')
    const caller = freshPane('ws1')
    grant(caller.externalId, 'type-other-pane')
    grant(caller.externalId, 'all-workspaces')
    const conn = await client(caller)
    for (const pane of [foreign.externalId, sibling.externalId]) {
      await expect(conn.sendRequest('pane.wake', { panes: [pane] })).rejects.toThrow('sandboxed:')
    }
    expect(woken).toEqual([])
  })

  it('answers unknown-pane for the manager pane and refuses the caller its own pane', async () => {
    answer = 'once'
    asleepPanes.add('mgr-pane')
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.wake', { panes: [manager.externalId] })).rejects.toThrow(
      `unknown-pane: ${manager.externalId}`,
    )
    await expect(conn.sendRequest('pane.wake', { panes: [agent.externalId] })).rejects.toThrow(
      'own-pane',
    )
    expect(woken).toEqual([])
  })

  it('refuses an empty pane list and is not available to extensions', async () => {
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.wake', { panes: [] })).rejects.toThrow('bad-request: panes')
    setCaps(extension.externalId, ['process', 'all-workspaces', 'type-other-pane'])
    const ext = await client(extension)
    await expect(
      ext.sendRequest('pane.wake', { panes: [sibling.externalId], targetPaneId: agent.externalId }),
    ).rejects.toThrow('not-available-to-extension')
  })

  it('refuses to type into a hibernated pane and says how to wake it', async () => {
    asleepPanes.add('child-pane')
    const conn = await client(agent)
    await expect(
      conn.sendRequest('pane.input', { pane: 'echo', text: 'hi', keys: ['enter'] }),
    ).rejects.toThrow(`hibernated: ${child.externalId} is asleep; wake it with ostia pane wake`)
    expect(written).toEqual([])
  })

  it('refuses text and keys to a woken pane until its agent started', async () => {
    asleepPanes.add('child-pane')
    const conn = await client(agent)
    await conn.sendRequest('pane.wake', { panes: ['echo'] })
    expect(waking.has('child-pane')).toBe(true)
    const refusal = `waking: ${child.externalId} is starting its agent; wait for it with ostia pane wake --wait`
    await expect(
      conn.sendRequest('pane.input', { pane: 'echo', text: 'hi', keys: ['enter'] }),
    ).rejects.toThrow(refusal)
    await expect(
      conn.sendRequest('pane.input', { pane: 'echo', keys: ['enter'], force: true }),
    ).rejects.toThrow(refusal)
    expect(written).toEqual([])
    waking.end('child-pane', 'started')
    await conn.sendRequest('pane.input', { pane: 'echo', text: 'hi', keys: ['enter'] })
    expect(written.map((w) => w.data)).toEqual(['hi', '\r'])
  })

  it('with wait answers only once the woken agent started', async () => {
    asleepPanes.add('child-pane')
    const conn = await client(agent)
    const done = vi.fn()
    const reply = conn.sendRequest('pane.wake', { panes: ['echo'], wait: true }).then((r) => {
      done()
      return r
    })
    await vi.waitFor(() => expect(waking.has('child-pane')).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(done).not.toHaveBeenCalled()
    waking.end('child-pane', 'started')
    await expect(reply).resolves.toEqual({ ok: true, woke: [child.externalId], started: true })
  })

  it('with wait waits on a pane that is already waking instead of waking it again', async () => {
    waking.start('child-pane')
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.wake', { panes: ['echo'] })).rejects.toThrow(
      'not-hibernated',
    )
    const reply = conn.sendRequest('pane.wake', { panes: ['echo'], wait: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    waking.end('child-pane', 'started')
    await expect(reply).resolves.toEqual({ ok: true, woke: [], started: true })
    expect(woken).toEqual([])
  })

  it('with wait reports a closed pane, a resume that failed, and a timeout', async () => {
    const conn = await client(agent)
    asleepPanes.add('child-pane')
    const closing = conn.sendRequest('pane.wake', { panes: ['echo'], wait: true })
    await vi.waitFor(() => expect(waking.has('child-pane')).toBe(true))
    waking.end('child-pane', 'closed')
    await expect(closing).resolves.toEqual({
      ok: true,
      woke: [child.externalId],
      closed: child.externalId,
    })

    asleepPanes.add('child-pane')
    const failing = conn.sendRequest('pane.wake', { panes: ['echo'], wait: true })
    await vi.waitFor(() => expect(waking.has('child-pane')).toBe(true))
    waking.end('child-pane', 'failed')
    await expect(failing).rejects.toThrow(
      `resume-failed: ${child.externalId} could not start its agent`,
    )

    asleepPanes.add('child-pane')
    await expect(
      conn.sendRequest('pane.wake', { panes: ['echo'], wait: true, timeoutMs: 1 }),
    ).resolves.toEqual({ ok: true, woke: [child.externalId], timedOut: true })
    expect(waking.has('child-pane')).toBe(true)
  })

  it('refuses a bad wait flag or timeout', async () => {
    asleepPanes.add('child-pane')
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.wake', { panes: ['echo'], wait: 'yes' })).rejects.toThrow(
      'bad-request: wait',
    )
    await expect(
      conn.sendRequest('pane.wake', { panes: ['echo'], wait: true, timeoutMs: 'soon' }),
    ).rejects.toThrow('bad-request: timeoutMs')
    expect(woken).toEqual([])
  })
})

describe('pane.close', () => {
  it('closes a tab the caller opened, by process name, without asking', async () => {
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.close', { panes: ['echo'] })).resolves.toEqual({
      ok: true,
      closed: [child.externalId],
    })
    expect(closed).toEqual(['child-pane'])
    expect(request).not.toHaveBeenCalled()
  })

  it('asks for kill-pane before closing a pane the caller did not open, and stops on Deny', async () => {
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.close', { panes: [sibling.externalId] })).rejects.toThrow(
      'denied: kill-pane',
    )
    expect(asked[0]).toMatchObject({ caps: ['kill-pane'], action: 'pane.close' })
    expect(closed).toEqual([])
    answer = 'once'
    await conn.sendRequest('pane.close', { panes: [sibling.externalId] })
    expect(closed).toEqual(['sibling-pane'])
  })

  it('needs all-workspaces as well for a pane in another workspace', async () => {
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.close', { panes: [foreign.externalId] })).rejects.toThrow(
      'denied: kill-pane, all-workspaces',
    )
    expect(closed).toEqual([])
  })

  it('checks every named pane before closing any', async () => {
    const conn = await client(agent)
    await expect(
      conn.sendRequest('pane.close', { panes: ['echo', sibling.externalId] }),
    ).rejects.toThrow('denied: kill-pane')
    expect(closed).toEqual([])
  })

  it('answers pane-locked for a locked pane', async () => {
    lockedPanes.add('child-pane')
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.close', { panes: ['echo'] })).rejects.toThrow('pane-locked')
    expect(closed).toEqual([])
  })

  it('answers unknown-pane for an unknown name and for the manager pane', async () => {
    answer = 'once'
    const conn = await client(agent)
    await expect(conn.sendRequest('pane.close', { panes: ['nope'] })).rejects.toThrow(
      'unknown-pane: nope',
    )
    await expect(conn.sendRequest('pane.close', { panes: [manager.externalId] })).rejects.toThrow(
      `unknown-pane: ${manager.externalId}`,
    )
    expect(closed).toEqual([])
  })

  it('refuses a sandboxed caller at a host pane', async () => {
    sandboxedWorkspaces.add('ws1')
    const caller = freshPane('ws1')
    grant(caller.externalId, 'kill-pane')
    const conn = await client(caller)
    await expect(conn.sendRequest('pane.close', { panes: [sibling.externalId] })).rejects.toThrow(
      'sandboxed:',
    )
    expect(closed).toEqual([])
  })

  it('is not available to extensions', async () => {
    setCaps(extension.externalId, ['process', 'all-workspaces', 'kill-pane'])
    const ext = await client(extension)
    await expect(
      ext.sendRequest('pane.close', {
        panes: [sibling.externalId],
        targetPaneId: agent.externalId,
      }),
    ).rejects.toThrow('not-available-to-extension')
  })
})

describe('pasteBytes', () => {
  it('wraps text in paste markers, sends newlines as Enter, drops embedded markers', () => {
    expect(pasteBytes('a\nb\r\nc')).toBe('\x1b[200~a\rb\rc\x1b[201~')
    expect(pasteBytes('x\x1b[201~rm -rf /\x1b[200~')).toBe('\x1b[200~xrm -rf /\x1b[201~')
  })

  it('gives back the text of a paste it wrapped, and nothing for other bytes', () => {
    expect(pastedText(pasteBytes('a\nb'))).toBe('a\rb')
    expect(pastedText('a\rb')).toBeNull()
    expect(pastedText('\x1b[200~a\x1b[201~b\x1b[201~')).toBeNull()
  })
})

describe('pane.input for unattended agents', () => {
  const task = 'Fix the login bug.\n\nSteps:\n1. read auth.ts\n2. add a test'

  async function granted() {
    const caller = freshPane('ws1')
    grant(caller.externalId, 'type-other-pane')
    return client(caller)
  }

  it('delivers a multi-line task as one paste and presses Enter only after it', async () => {
    pasteMode.add('sibling-pane')
    const conn = await granted()

    const res = await conn.sendRequest('pane.input', {
      pane: sibling.externalId,
      text: task,
      keys: ['enter'],
    })

    expect(written).toEqual([
      { paneId: 'sibling-pane', data: `\x1b[200~${task.replaceAll('\n', '\r')}\x1b[201~` },
      { paneId: 'sibling-pane', data: '\r' },
    ])
    expect(written[0].data.split('\x1b[201~')).toHaveLength(2)
    expect(delays).toEqual([100])
    expect(res).toMatchObject({ ok: true, pasted: true })
    expect(typedInto).toEqual(['sibling-pane'])
  })

  it('types raw text when the program has no bracketed paste, or paste is false', async () => {
    const conn = await granted()
    const res = await conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'a\nb' })
    expect(res).toMatchObject({ pasted: false })
    pasteMode.add('sibling-pane')
    await conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'c\nd', paste: false })
    expect(written.map((w) => w.data)).toEqual(['a\nb', 'c\nd'])
  })

  it('pastes single-line text only when asked', async () => {
    pasteMode.add('sibling-pane')
    const conn = await granted()
    await conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'ls', keys: ['enter'] })
    await conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'ls', paste: true })
    expect(written.map((w) => w.data)).toEqual(['ls', '\r', '\x1b[200~ls\x1b[201~'])
  })

  it('presses Enter after one line of text only once the text settled, pasted or typed', async () => {
    const conn = await granted()
    await conn.sendRequest('pane.input', {
      pane: sibling.externalId,
      text: 'one line of text',
      keys: ['enter'],
    })
    expect(written.map((w) => w.data)).toEqual(['one line of text', '\r'])
    expect(delays).toEqual([100])

    pasteMode.add('sibling-pane')
    await conn.sendRequest('pane.input', {
      pane: sibling.externalId,
      text: 'one line of text',
      keys: ['enter'],
      paste: true,
    })
    expect(written.map((w) => w.data).slice(2)).toEqual([
      '\x1b[200~one line of text\x1b[201~',
      '\r',
    ])
    expect(delays).toEqual([100, 100])
  })

  it('refuses text to an agent waiting for the human and says why', async () => {
    attentionOf.set('sibling-pane', { state: 'waiting', message: 'Allow Bash: rm -rf build?' })
    const conn = await granted()

    await expect(
      conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'next task' }),
    ).rejects.toThrow(/agent-waiting: .*Allow Bash: rm -rf build\?/)
    expect(written).toEqual([])
    expect(typedInto).toEqual([])
  })

  it('refuses a script token text to a waiting agent just as it refuses a pane', async () => {
    const conn = await client({ token: SCRIPT_TOKEN })
    attentionOf.set('sibling-pane', { state: 'working' })
    await conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'first task' })

    attentionOf.set('sibling-pane', { state: 'waiting', message: 'Allow Bash: git push?' })
    await expect(
      conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'next task' }),
    ).rejects.toThrow(/agent-waiting: .*Allow Bash: git push\?/)
    expect(written.map((w) => w.data)).toEqual(['first task'])
    expect(typedInto).toEqual(['sibling-pane'])
    expect(request).not.toHaveBeenCalled()
  })

  it('still lets keys answer a waiting agent, and force types text anyway', async () => {
    attentionOf.set('sibling-pane', { state: 'waiting' })
    const conn = await granted()
    await conn.sendRequest('pane.input', { pane: sibling.externalId, keys: ['enter'] })
    await conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'y', force: true })
    expect(written.map((w) => w.data)).toEqual(['\r', 'y'])
    expect(typedInto).toEqual(['sibling-pane', 'sibling-pane'])
  })

  it('does not ask a working or finished agent anything before typing', async () => {
    attentionOf.set('sibling-pane', { state: 'working' })
    const conn = await granted()
    await conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'more' })
    expect(written.map((w) => w.data)).toEqual(['more'])
  })

  it('reports whether the program answered when confirm is set', async () => {
    const conn = await granted()
    const seen = await conn.sendRequest('pane.input', {
      pane: sibling.externalId,
      text: 'x',
      confirm: true,
    })
    expect(seen).toMatchObject({ responded: true, bytes: 1 })

    echoes = false
    const silent = await conn.sendRequest('pane.input', {
      pane: sibling.externalId,
      text: 'y',
      confirm: true,
      confirmMs: 120,
    })
    expect(silent).toMatchObject({ responded: false })
    expect(delays.filter((ms) => ms === 50)).toHaveLength(3)
  })

  it('refuses malformed flags', async () => {
    const conn = await granted()
    for (const params of [{ paste: 'yes' }, { force: 1 }, { confirm: 'true' }, { confirmMs: -1 }]) {
      await expect(
        conn.sendRequest('pane.input', { pane: sibling.externalId, text: 'x', ...params }),
      ).rejects.toThrow('bad-request')
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
