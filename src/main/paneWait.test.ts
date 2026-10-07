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
import type { CommandResult } from '../shared/types'
import type { ApprovalAsk } from './approvals'

let answer: ApprovalOutcome = 'deny'
const asked: ApprovalAsk[] = []
const request = vi.fn(async (ask: ApprovalAsk) => {
  asked.push(ask)
  return answer
})

vi.mock('./approvals', () => ({ approvals: () => ({ request }) }))

const { setCapFilter } = await import('./controlAuth')
const { registerControlServer, stopControlServer } = await import('./controlServer')
const { registerPane } = await import('./idRegistry')
const { PaneWatch, reachedState, registerPaneWaitMethods, waitTimeout, waitUntil } = await import(
  './paneWait'
)

type Identity = ReturnType<typeof registerPane>

const watch = new PaneWatch()
const children = new Map<string, string>()
const processes = new Map<string, string>()
const attentionOf = new Map<string, { state?: string; message?: string }>()
const exitedPanes = new Set<string>()

registerPaneWaitMethods({
  processPane: (ref) => processes.get(ref),
  isChild: (ownerPaneId, paneId) => children.get(paneId) === ownerPaneId,
  createdWorkspace: () => false,
  isSandboxed: () => false,
  isConfined: () => false,
  watch,
  attention: async (pane) => attentionOf.get(pane.paneId) ?? {},
  exited: (paneId) => exitedPanes.has(paneId),
})

let seq = 0
let socketPath = ''
const clients: MessageConnection[] = []

function pane(workspaceId: string): Identity {
  seq += 1
  return registerPane({ windowId: 'w1', workspaceId, paneId: `wait-pane-${seq}` })
}

function caller(): { me: Identity; worker: Identity } {
  const me = pane('ws1')
  const worker = pane('ws1')
  children.set(worker.paneId, me.paneId)
  processes.set(`worker-${seq}`, worker.paneId)
  return { me, worker }
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  seq += 1
  socketPath = join(tmpdir(), `ostia-pane-wait-${process.pid}-${seq}.sock`)
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
  attentionOf.clear()
  exitedPanes.clear()
  setCapFilter(() => true)
})

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
  stopControlServer()
})

describe('reachedState', () => {
  it('stops on done, waiting or exited by default and reads no state as idle', () => {
    const until = waitUntil(undefined)
    expect(reachedState({ attention: { state: 'done' }, exited: false }, until)).toBe('done')
    expect(reachedState({ attention: { state: 'waiting' }, exited: false }, until)).toBe('waiting')
    expect(reachedState({ attention: { state: 'working' }, exited: true }, until)).toBe('exited')
    expect(reachedState({ attention: { state: 'working' }, exited: false }, until)).toBeUndefined()
    expect(reachedState({ attention: {}, exited: false }, until)).toBeUndefined()
    expect(reachedState({ attention: {}, exited: false }, ['idle'])).toBe('idle')
  })

  it('refuses unknown states and clamps the timeout between 1 s and 30 minutes', () => {
    expect(() => waitUntil(['finished'])).toThrow('bad-request: until finished')
    expect(() => waitUntil([])).toThrow('bad-request: until')
    expect(waitTimeout(undefined)).toBe(600_000)
    expect(waitTimeout(5)).toBe(1000)
    expect(waitTimeout(10_000_000)).toBe(1_800_000)
    expect(() => waitTimeout('soon')).toThrow('bad-request: timeoutMs')
  })
})

describe('pane.wait', () => {
  it('answers at once for a tab the caller opened that is already done', async () => {
    const { me, worker } = caller()
    attentionOf.set(worker.paneId, { state: 'done', message: 'tests pass' })
    const conn = await client(me)
    await expect(
      conn.sendRequest('pane.wait', { panes: [`worker-${seq}`], timeoutMs: 1000 }),
    ).resolves.toEqual({
      reached: true,
      paneId: worker.externalId,
      state: 'done',
      message: 'tests pass',
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('wakes when the pane reports a state change', async () => {
    const { me, worker } = caller()
    attentionOf.set(worker.paneId, { state: 'working' })
    const conn = await client(me)
    const pending = conn.sendRequest('pane.wait', { panes: [worker.externalId] })
    await tick()
    watch.attention(worker.paneId, 'waiting', 'Allow Bash(rm -rf build)?')
    await expect(pending).resolves.toEqual({
      reached: true,
      paneId: worker.externalId,
      state: 'waiting',
      message: 'Allow Bash(rm -rf build)?',
    })
  })

  it('wakes on exited when the command ends', async () => {
    const { me, worker } = caller()
    attentionOf.set(worker.paneId, { state: 'working' })
    const conn = await client(me)
    const pending = conn.sendRequest('pane.wait', { panes: [worker.externalId] })
    await tick()
    exitedPanes.add(worker.paneId)
    watch.emit(worker.paneId, { kind: 'state' })
    await expect(pending).resolves.toEqual({
      reached: true,
      paneId: worker.externalId,
      state: 'exited',
    })
  })

  it('ignores done when asked only for waiting', async () => {
    const { me, worker } = caller()
    attentionOf.set(worker.paneId, { state: 'done' })
    const conn = await client(me)
    const pending = conn.sendRequest('pane.wait', {
      panes: [worker.externalId],
      until: ['waiting'],
    })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await tick()
    watch.attention(worker.paneId, 'done', 'again')
    await tick()
    expect(settled).toBe(false)
    watch.attention(worker.paneId, 'waiting', 'question')
    await expect(pending).resolves.toMatchObject({ state: 'waiting', message: 'question' })
  })

  it('returns whichever of several panes stops first', async () => {
    const { me, worker } = caller()
    const other = pane('ws1')
    children.set(other.paneId, me.paneId)
    const conn = await client(me)
    const pending = conn.sendRequest('pane.wait', {
      panes: [worker.externalId, other.externalId],
    })
    await tick()
    watch.attention(other.paneId, 'done', undefined)
    await expect(pending).resolves.toEqual({
      reached: true,
      paneId: other.externalId,
      state: 'done',
    })
  })

  it('times out when nothing changes', async () => {
    const { me, worker } = caller()
    attentionOf.set(worker.paneId, { state: 'working' })
    const conn = await client(me)
    await expect(
      conn.sendRequest('pane.wait', { panes: [worker.externalId], timeoutMs: 1000 }),
    ).resolves.toEqual({ timedOut: true })
  })

  it('reports a pane that closes while waited on', async () => {
    const { me, worker } = caller()
    attentionOf.set(worker.paneId, { state: 'working' })
    const conn = await client(me)
    const pending = conn.sendRequest('pane.wait', { panes: [worker.externalId] })
    await tick()
    watch.emit(worker.paneId, { kind: 'closed' })
    await expect(pending).resolves.toEqual({ closed: true, paneId: worker.externalId })
  })

  it('asks for read-other-pane before waiting on a pane the caller did not open', async () => {
    const me = pane('ws1')
    const sibling = pane('ws1')
    attentionOf.set(sibling.paneId, { state: 'done' })
    const conn = await client(me)
    await expect(conn.sendRequest('pane.wait', { panes: [sibling.externalId] })).rejects.toThrow(
      'denied: read-other-pane',
    )
    expect(asked[0]).toMatchObject({ caps: ['read-other-pane'], action: 'pane.wait' })
  })

  it('also asks for all-workspaces for a pane in another workspace', async () => {
    const me = pane('ws1')
    const foreign = pane('ws2')
    const conn = await client(me)
    await expect(conn.sendRequest('pane.wait', { panes: [foreign.externalId] })).rejects.toThrow(
      'denied',
    )
    expect(asked[0]).toMatchObject({ caps: ['read-other-pane', 'all-workspaces'] })
  })

  it('refuses an unknown pane', async () => {
    const me = pane('ws1')
    const conn = await client(me)
    await expect(conn.sendRequest('pane.wait', { panes: ['nope'] })).rejects.toThrow(
      'unknown-pane: nope',
    )
  })
})

describe('PaneWatch.attention', () => {
  it('passes only known states on, reads none as no state and clips the message', () => {
    const seen: unknown[] = []
    const off = watch.watch('p', (change) => seen.push(change))
    watch.attention('p', 'bogus', 'x')
    watch.attention('p', 'none', 'old')
    watch.attention('p', 'done', `  ${'m'.repeat(2000)}  `)
    off()
    watch.attention('p', 'done', 'after')
    expect(seen).toEqual([
      { kind: 'attention', attention: {} },
      { kind: 'attention', attention: { state: 'done', message: 'm'.repeat(1024) } },
    ])
  })
})
