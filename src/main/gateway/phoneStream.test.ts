import { afterAll, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type { StreamEvent } from '../../shared/agents/agentStream'
import type { PreparedStream, StreamSend } from '../agents/agentStreams'
import { registerPane, removePane } from '../control/idRegistry'
import type { WorkspaceEntry } from '../panes/paneList'
import type { GatewayControlDeps } from './controlDispatch'
import type { Device } from './devices'
import type { SocketState } from './phoneSocket'
import {
  STREAMS_PER_SOCKET,
  closeStreams,
  handleStreamClose,
  handleStreamOpen,
} from './phoneStream'

const workspaces: WorkspaceEntry[] = [
  { workspaceId: 'w1', name: 'One', kind: 'agent', workDir: '/work/one', state: 'idle' },
  { workspaceId: 'pad', name: 'Pad', kind: 'scratch', workDir: '/s', state: 'idle' },
  { workspaceId: 'box', name: 'Box', kind: 'agent', workDir: '/b', state: 'idle', sandboxed: true },
]
const agent = registerPane({ windowId: 'win', workspaceId: 'w1', paneId: 'ps-agent' })
const scratch = registerPane({ windowId: 'win', workspaceId: 'pad', paneId: 'ps-pad' })
const boxed = registerPane({ windowId: 'win', workspaceId: 'box', paneId: 'ps-box' })
const remote = registerPane({ windowId: 'win', workspaceId: 'w1', paneId: 'ps-remote' })
const away = registerPane({ windowId: 'win', workspaceId: 'gone', paneId: 'ps-away' })
const manager = registerPane({ windowId: 'win', workspaceId: 'w1', paneId: 'ps-manager' })
manager.manager = true

afterAll(() => {
  for (const id of ['ps-agent', 'ps-pad', 'ps-box', 'ps-remote', 'ps-away', 'ps-manager']) {
    removePane(id)
  }
})

const FRAME = 4000

function device(caps = ['read', 'notify']): Device {
  return { deviceId: 'd1', caps } as Device
}

function harness(
  opened: () => Promise<PreparedStream | { error: 'not-an-agent' | 'unavailable' }>,
) {
  const sent: Array<Record<string, unknown>> = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (frame: string) => sent.push(JSON.parse(frame)),
  } as unknown as WebSocket
  const state = { streams: new Map() } as unknown as SocketState
  const open = vi.fn(opened)
  const deps = {
    listWorkspaces: async () => workspaces,
    remote: (paneId: string) => paneId === 'ps-remote',
    agentStreams: { open },
  } as unknown as GatewayControlDeps
  const call = async (params: unknown, who: Device = device()) => {
    handleStreamOpen(ws, state, who, { id: 1, params }, deps, FRAME)
    await vi.waitFor(() => expect(sent.some((m) => m.id === 1 || 'error' in m)).toBe(true))
    return sent.find((m) => m.id === 1) as {
      result?: Record<string, unknown>
      error?: { code: number; message: string; data?: unknown }
    }
  }
  const frames = () =>
    sent
      .filter((m) => (m.params as { type?: string } | undefined)?.type === 'agent.stream')
      .map((m) => (m.params as { payload: Record<string, unknown> }).payload)
  return { ws, state, open, call, sent, frames, deps }
}

function prepared(over: Partial<PreparedStream> = {}) {
  let send: StreamSend = () => undefined
  const value: PreparedStream = {
    agent: 'claude',
    session: 's1',
    truncated: false,
    start: (fn) => {
      send = fn
    },
    close: vi.fn(),
    ...over,
  }
  return { value, push: (events: StreamEvent[], backfill = false) => send(events, backfill) }
}

describe('agent.stream.open', () => {
  it('replies, then sends the backfill flagged and live events numbered in order', async () => {
    const p = prepared()
    const h = harness(async () => p.value)
    const res = await h.call({ paneId: agent.externalId, turns: 3 })
    expect(res.result).toEqual({
      ok: true,
      paneId: agent.externalId,
      agent: 'claude',
      session: 's1',
      truncated: false,
    })
    expect(h.open).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'ps-agent' }), 3)
    p.push([{ type: 'turn.started', turn: 'u1' }, { type: 'live' }], true)
    p.push([{ type: 'text', turn: 'u1', id: 'a', text: 'hi' }])
    expect(h.sent[0].id).toBe(1)
    expect(h.frames()).toEqual([
      {
        paneId: agent.externalId,
        seq: 1,
        backfill: true,
        events: [{ type: 'turn.started', turn: 'u1' }, { type: 'live' }],
      },
      {
        paneId: agent.externalId,
        seq: 2,
        events: [{ type: 'text', turn: 'u1', id: 'a', text: 'hi' }],
      },
    ])
  })

  it('defaults to 5 turns and refuses a count outside 1 to 50', async () => {
    const h = harness(async () => prepared().value)
    await h.call({ paneId: agent.externalId })
    expect(h.open).toHaveBeenLastCalledWith(expect.anything(), 5)
    for (const turns of [0, 51, 1.5, '3', null]) {
      h.sent.length = 0
      const res = await h.call({ paneId: agent.externalId, turns })
      expect(res.error).toEqual({ code: -32602, message: 'bad-params' })
    }
  })

  it('splits a huge event over frames that each fit the cap, and loses none of it', async () => {
    const p = prepared()
    const h = harness(async () => p.value)
    await h.call({ paneId: agent.externalId })
    const output = 'line of output\n'.repeat(2000)
    p.push([{ type: 'tool.result', turn: 'u1', id: 'tu', output, exitCode: 0 }], true)
    const frames = h.frames()
    expect(frames.length).toBeGreaterThan(5)
    for (const frame of h.sent.slice(1)) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(FRAME)
    }
    const joined = frames
      .flatMap((f) => f.events as Array<{ output: string }>)
      .map((e) => e.output)
      .join('')
    expect(joined).toBe(output)
  })

  describe('scope', () => {
    const refused = async (paneId: unknown, message: string, code = -32602) => {
      const h = harness(async () => prepared().value)
      const res = await h.call({ paneId })
      expect(res.error).toEqual({ code, message })
      expect(h.open).not.toHaveBeenCalled()
      expect(h.state.streams.size).toBe(0)
    }

    it('refuses a pane of a workspace session.list does not show', () =>
      refused(away.externalId, 'unknown-pane'))
    it('refuses a scratch workspace', () => refused(scratch.externalId, 'unknown-pane'))
    it('refuses a sandboxed workspace', () => refused(boxed.externalId, 'unknown-pane'))
    it('refuses a remote pane', () => refused(remote.externalId, 'unknown-pane'))
    it('refuses the manager pane', () => refused(manager.externalId, 'not-an-agent'))
    it('refuses an unknown pane id', () =>
      refused('00000000-0000-4000-8000-000000000000', 'not-an-agent'))
    it('refuses a missing pane id', () => refused(undefined, 'missing paneId'))

    it('needs the read cap', async () => {
      const h = harness(async () => prepared().value)
      const res = await h.call({ paneId: agent.externalId }, device(['notify']))
      expect(res.error).toEqual({ code: -32003, message: 'needs-elevation', data: { cap: 'read' } })
      expect(h.open).not.toHaveBeenCalled()
    })
  })

  it('answers not-an-agent for a shell and unavailable when the source cannot start', async () => {
    const shell = harness(async () => ({ error: 'not-an-agent' as const }))
    expect((await shell.call({ paneId: agent.externalId })).error).toEqual({
      code: -32602,
      message: 'not-an-agent',
    })
    const down = harness(async () => ({ error: 'unavailable' as const }))
    expect((await down.call({ paneId: agent.externalId })).error).toEqual({
      code: -32603,
      message: 'unavailable',
    })
    expect(shell.state.streams.size).toBe(0)
  })

  it('reopening a pane replaces its stream, and a socket holds at most four', async () => {
    const made: ReturnType<typeof prepared>[] = []
    const h = harness(async () => {
      const p = prepared()
      made.push(p)
      return p.value
    })
    await h.call({ paneId: agent.externalId })
    h.sent.length = 0
    await h.call({ paneId: agent.externalId })
    expect(made[0].value.close).toHaveBeenCalledTimes(1)
    expect(h.state.streams.size).toBe(1)

    for (let i = 1; i < STREAMS_PER_SOCKET; i++) h.state.streams.set(`other-${i}`, prepared().value)
    h.sent.length = 0
    const res = await h.call({ paneId: manager.externalId })
    expect(res.error?.message).toBe('not-an-agent')
    h.sent.length = 0
    h.state.streams.delete(agent.externalId)
    h.state.streams.set('other-9', prepared().value)
    const full = await h.call({ paneId: agent.externalId })
    expect(full.error).toEqual({ code: -32602, message: 'too-many-streams' })
  })

  it('drops a stream that finished opening after the socket closed', async () => {
    const p = prepared()
    const h = harness(async () => p.value)
    ;(h.ws as unknown as { readyState: number }).readyState = 3
    handleStreamOpen(
      h.ws,
      h.state,
      device(),
      { id: 1, params: { paneId: agent.externalId } },
      h.deps,
      FRAME,
    )
    await vi.waitFor(() => expect(p.value.close).toHaveBeenCalled())
    expect(h.sent).toEqual([])
    expect(h.state.streams.size).toBe(0)
  })
})

describe('agent.stream.close', () => {
  it('stops the stream and answers ok, also for a pane that was not streaming', async () => {
    const p = prepared()
    const h = harness(async () => p.value)
    await h.call({ paneId: agent.externalId })
    h.sent.length = 0
    handleStreamClose(h.ws, h.state, { id: 2, params: { paneId: agent.externalId } })
    expect(p.value.close).toHaveBeenCalledTimes(1)
    expect(h.state.streams.size).toBe(0)
    expect(h.sent).toEqual([{ jsonrpc: '2.0', id: 2, result: { ok: true } }])
    handleStreamClose(h.ws, h.state, { id: 3, params: { paneId: 'nope' } })
    expect(h.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 3, result: { ok: true } })
  })

  it('closeStreams stops every stream of a socket', async () => {
    const p = prepared()
    const q = prepared()
    const state = {
      streams: new Map([
        ['a', p.value],
        ['b', q.value],
      ]),
    }
    closeStreams(state)
    expect(p.value.close).toHaveBeenCalledTimes(1)
    expect(q.value.close).toHaveBeenCalledTimes(1)
    expect(state.streams.size).toBe(0)
  })
})
