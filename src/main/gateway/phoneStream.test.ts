import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type { StreamEvent } from '../../shared/agents/agentStream'
import type { PreparedStream, StreamSend } from '../agents/agentStreams'
import { registerPane, removePane } from '../control/idRegistry'
import type { WorkspaceEntry } from '../panes/paneList'
import type { GatewayControlDeps } from './controlDispatch'
import type { Device } from './devices'
import type { SocketState } from './phoneSocket'
import {
  closeStreams,
  handleStreamClose,
  handleStreamOpen,
  SCOPE_CHECK_MS,
  STREAM_BUFFER_MAX,
  STREAMS_PER_SOCKET,
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
const extra = [1, 2, 3, 4, 5].map((n) =>
  registerPane({ windowId: 'win', workspaceId: 'w1', paneId: `ps-extra-${n}` }),
)

afterAll(() => {
  for (const id of ['ps-agent', 'ps-pad', 'ps-box', 'ps-remote', 'ps-away', 'ps-manager']) {
    removePane(id)
  }
  for (let n = 1; n <= 5; n++) removePane(`ps-extra-${n}`)
})

const FRAME = 4000

function device(caps = ['read', 'notify']): Device {
  return { deviceId: 'd1', caps } as Device
}

function harness(
  opened: () => Promise<PreparedStream | { error: 'not-an-agent' | 'unavailable' }>,
) {
  const sent: Array<Record<string, unknown>> = []
  let visible = workspaces
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (frame: string) => sent.push(JSON.parse(frame)),
  } as unknown as WebSocket
  const state = { streams: new Map() } as unknown as SocketState
  const open = vi.fn(opened)
  const deps = {
    listWorkspaces: async () => visible,
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
  const show = (next: WorkspaceEntry[]): void => {
    visible = next
  }
  return { ws, state, open, call, sent, frames, deps, show }
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

describe('agent.stream.open, limits and lifetime', () => {
  it('holds four streams at most even when five opens are in flight at once', async () => {
    const h = harness(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return prepared().value
    })
    for (const [i, pane] of extra.entries()) {
      handleStreamOpen(
        h.ws,
        h.state,
        device(),
        { id: 100 + i, params: { paneId: pane.externalId } },
        h.deps,
        FRAME,
      )
    }
    await vi.waitFor(() =>
      expect(h.sent.filter((m) => 'id' in m && (m.id as number) >= 100)).toHaveLength(5),
    )
    const answers = h.sent.filter((m) => 'id' in m && (m.id as number) >= 100) as Array<{
      result?: unknown
      error?: { message: string }
    }>
    expect(answers.filter((m) => m.result)).toHaveLength(STREAMS_PER_SOCKET)
    expect(answers.filter((m) => m.error?.message === 'too-many-streams')).toHaveLength(1)
    expect(h.state.streams.size).toBe(STREAMS_PER_SOCKET)
  })

  it('drops a stream whose open was superseded by a close while it was still opening', async () => {
    const p = prepared()
    const h = harness(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return p.value
    })
    handleStreamOpen(
      h.ws,
      h.state,
      device(),
      { id: 1, params: { paneId: agent.externalId } },
      h.deps,
      FRAME,
    )
    handleStreamClose(h.ws, h.state, { id: 2, params: { paneId: agent.externalId } })
    await vi.waitFor(() => expect(p.value.close).toHaveBeenCalled())
    expect(h.state.streams.size).toBe(0)
    expect(h.sent.some((m) => m.id === 1)).toBe(false)
  })

  describe('while streaming', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    async function streaming() {
      const p = prepared()
      const h = harness(async () => p.value)
      handleStreamOpen(
        h.ws,
        h.state,
        device(),
        { id: 1, params: { paneId: agent.externalId } },
        h.deps,
        FRAME,
      )
      await vi.advanceTimersByTimeAsync(5)
      return { p, h }
    }
    const lastEnded = (h: ReturnType<typeof harness>) =>
      h
        .frames()
        .flatMap((f) => f.events as Array<{ type: string; reason?: string }>)
        .filter((e) => e.type === 'ended')

    it('ends the stream when its workspace leaves what session.list shows', async () => {
      const { p, h } = await streaming()
      await vi.advanceTimersByTimeAsync(SCOPE_CHECK_MS + 10)
      expect(lastEnded(h)).toEqual([])
      h.show([])
      await vi.advanceTimersByTimeAsync(SCOPE_CHECK_MS + 10)
      expect(lastEnded(h)).toEqual([{ type: 'ended', reason: 'out-of-scope' }])
      expect(p.value.close).toHaveBeenCalledTimes(1)
      expect(h.state.streams.size).toBe(0)
    })

    it('ends the stream when its workspace becomes sandboxed or scratch', async () => {
      for (const next of [
        [{ ...workspaces[0], sandboxed: true }],
        [{ ...workspaces[0], kind: 'scratch' }],
      ]) {
        const { p, h } = await streaming()
        h.show(next)
        await vi.advanceTimersByTimeAsync(SCOPE_CHECK_MS + 10)
        expect(lastEnded(h)).toEqual([{ type: 'ended', reason: 'out-of-scope' }])
        expect(p.value.close).toHaveBeenCalled()
      }
    })

    it('stops checking once the stream is closed', async () => {
      const { h } = await streaming()
      handleStreamClose(h.ws, h.state, { id: 2, params: { paneId: agent.externalId } })
      h.show([])
      await vi.advanceTimersByTimeAsync(SCOPE_CHECK_MS * 3)
      expect(lastEnded(h)).toEqual([])
    })

    it('ends the stream as too-slow instead of queueing without limit for a phone that does not read', async () => {
      const { p, h } = await streaming()
      ;(h.ws as unknown as { bufferedAmount: number }).bufferedAmount = STREAM_BUFFER_MAX + 1
      p.push([{ type: 'text', turn: 'u1', id: 'a', text: 'hi' }])
      expect(lastEnded(h)).toEqual([{ type: 'ended', reason: 'too-slow' }])
      expect(p.value.close).toHaveBeenCalledTimes(1)
      p.push([{ type: 'text', turn: 'u1', id: 'b', text: 'more' }])
      expect(h.frames().flatMap((f) => f.events)).toHaveLength(1)
    })

    it('ends the stream as too-large for an event no frame can carry', async () => {
      const { p, h } = await streaming()
      p.push([
        {
          type: 'plan',
          turn: 'u1',
          id: 'p',
          items: [{ text: 'x'.repeat(FRAME * 2), status: 'pending' }],
        },
      ])
      expect(lastEnded(h)).toEqual([{ type: 'ended', reason: 'too-large' }])
      expect(p.value.close).toHaveBeenCalledTimes(1)
    })
  })
})
