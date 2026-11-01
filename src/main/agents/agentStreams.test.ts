import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamEvent } from '../../shared/agents/agentStream'
import { PiStream } from '../agent/piStream'
import type { Ask } from '../approvals/asks'
import type { PaneIdentity } from '../control/idRegistry'
import { setErrorSink } from '../diagnostics/errorReport'
import type { PaneEntry } from '../panes/paneList'
import { AgentStreams, type AgentStreamsDeps, type PreparedStream } from './agentStreams'
import type { CodexNotice, CodexRpc } from './codexRpc'

const pane = { kind: 'pane', externalId: 'ext-1', paneId: 'p1', workspaceId: 'w1' } as PaneIdentity

const user = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } })
const say = (uuid: string, text: string, stop?: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      ...(stop ? { stop_reason: stop } : {}),
    },
  })

let dir: string
let sessionFile: string
let entry: PaneEntry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ostia-stream-'))
  sessionFile = join(dir, 's1.jsonl')
  entry = {
    paneId: 'ext-1',
    workspaceId: 'w1',
    kind: 'terminal',
    title: 't',
    running: true,
    blockCount: 0,
    agent: 'claude',
    agentSessionId: 's1',
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Fake {
  streams: AgentStreams
  deps: AgentStreamsDeps
  rpc: { request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  notice: () => CodexNotice
  closeRpc: () => void
  asks: Ask[]
  pi: PiStream
}

function fake(over: Partial<AgentStreamsDeps> = {}): Fake {
  let notice: CodexNotice = () => undefined
  let closeRpc: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    closeRpc = resolve
  })
  const rpc = { request: vi.fn(), close: vi.fn() }
  const asks: Ask[] = []
  const pi = new PiStream()
  const deps: AgentStreamsDeps = {
    panes: async () => [entry],
    claudeFile: async (id) => (id === 's1' ? sessionFile : join(dir, `${id}.jsonl`)),
    codexSocket: () => '/tmp/codex.sock',
    codexConnect: async (_socket, onNotice) => {
      notice = onNotice
      return { ...rpc, closed } as unknown as CodexRpc
    },
    pi: () => pi,
    asks: () => asks,
    ...over,
  }
  return { streams: new AgentStreams(deps), deps, rpc, notice: () => notice, closeRpc, asks, pi }
}

async function opened(streams: AgentStreams, turns = 5): Promise<PreparedStream> {
  const result = await streams.open(pane, turns)
  if ('error' in result) throw new Error(result.error)
  return result
}

function collect(prepared: PreparedStream) {
  const sent: Array<{ events: StreamEvent[]; backfill: boolean }> = []
  prepared.start((events, backfill) => sent.push({ events, backfill }))
  return {
    sent,
    all: () => sent.flatMap((s) => s.events),
    live: () => sent.filter((s) => !s.backfill).flatMap((s) => s.events),
  }
}

const types = (events: StreamEvent[]) => events.map((e) => e.type)

describe('AgentStreams, Claude', () => {
  it('backfills the last turns from the session file, then follows what Claude appends', async () => {
    writeFileSync(
      sessionFile,
      `${[
        user('u1', 'first'),
        say('a1', 'one', 'end_turn'),
        user('u2', 'second'),
        say('a2', 'two', 'end_turn'),
        user('u3', 'third'),
      ].join('\n')}\n`,
    )
    const { streams } = fake()
    const prepared = await opened(streams, 2)
    expect(prepared).toMatchObject({ agent: 'claude', session: 's1', truncated: false })
    const got = collect(prepared)
    expect(got.sent[0].backfill).toBe(true)
    expect(got.all().filter((e) => e.type === 'prompt')).toEqual([
      { type: 'prompt', turn: 'u2', id: 'u2', text: 'second' },
      { type: 'prompt', turn: 'u3', id: 'u3', text: 'third' },
    ])
    expect(got.all().at(-1)).toEqual({ type: 'live' })

    appendFileSync(sessionFile, `${say('a3', 'streamed in', 'end_turn')}\n`)
    await vi.waitFor(() =>
      expect(got.live()).toEqual([
        { type: 'text', turn: 'u3', id: 'a3:0', text: 'streamed in' },
        { type: 'turn.ended', turn: 'u3', status: 'done' },
      ]),
    )
    prepared.close()
  })

  it('waits for a record that is only half written', async () => {
    writeFileSync(sessionFile, `${user('u1', 'go')}\n`)
    const { streams } = fake()
    const prepared = await opened(streams)
    const got = collect(prepared)
    const line = say('a1', 'whole')
    appendFileSync(sessionFile, line.slice(0, 20))
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(got.live()).toEqual([])
    appendFileSync(sessionFile, `${line.slice(20)}\n`)
    await vi.waitFor(() => expect(types(got.live())).toEqual(['text']))
    prepared.close()
  })

  it('starts with no events when the session file does not exist yet, and picks it up when it appears', async () => {
    const { streams } = fake()
    const prepared = await opened(streams)
    const got = collect(prepared)
    expect(got.all()).toEqual([{ type: 'live' }])
    writeFileSync(sessionFile, `${user('u1', 'hello')}\n`)
    await vi.waitFor(() => expect(types(got.live())).toEqual(['turn.started', 'prompt']))
    prepared.close()
  })

  it('starts the phone over, without repeating anything, when the file got shorter', async () => {
    writeFileSync(sessionFile, `${user('u1', 'a long first prompt, long enough to matter')}\n`)
    const { streams } = fake()
    const got = collect(await opened(streams))
    writeFileSync(sessionFile, `${user('n1', 'new')}\n`)
    await vi.waitFor(() =>
      expect(got.live().map((e) => e.type)).toEqual(['session', 'turn.started', 'prompt', 'live']),
    )
    expect(got.live()[0]).toEqual({ type: 'session', session: 's1' })
  })

  it('ends the stream as unavailable when the file keeps failing to read', async () => {
    const { streams } = fake()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const got = collect(await opened(streams))
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(300)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    vi.useRealTimers()
    expect(got.live()).toEqual([{ type: 'ended', reason: 'unavailable' }])
  })

  it('ends the stream at once and reports it when the lookup fails in a way that is not a file error', async () => {
    const warn = vi.fn()
    setErrorSink({ file: '', info: vi.fn(), warn, error: vi.fn() })
    let calls = 0
    const { streams } = fake({
      claudeFile: async () => {
        calls += 1
        if (calls > 1) throw new TypeError('bug')
        return null
      },
    })
    const got = collect(await opened(streams))
    await vi.waitFor(() => expect(got.live()).toEqual([{ type: 'ended', reason: 'unavailable' }]))
    expect(warn).toHaveBeenCalledWith('unexpected-error', {
      scope: 'streamClaude',
      name: 'TypeError',
      code: undefined,
    })
    setErrorSink(null)
  })

  it('stops reading once closed', async () => {
    writeFileSync(sessionFile, `${user('u1', 'go')}\n`)
    const { streams } = fake()
    const prepared = await opened(streams)
    const got = collect(prepared)
    prepared.close()
    appendFileSync(sessionFile, `${say('a1', 'late')}\n`)
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(got.live()).toEqual([])
  })

  it('follows /clear to the new session file and tells the phone to start over', async () => {
    writeFileSync(sessionFile, `${user('u1', 'old')}\n`)
    writeFileSync(join(dir, 's2.jsonl'), `${user('n1', 'fresh')}\n`)
    const { streams } = fake()
    const prepared = await opened(streams)
    const got = collect(prepared)
    streams.resumed('ext-1', { agent: 'claude', id: 's2' })
    await vi.waitFor(() => expect(got.all().filter((e) => e.type === 'live')).toHaveLength(2))
    const after = got.all().slice(got.all().findIndex((e) => e.type === 'session'))
    expect(after).toEqual([
      { type: 'session', session: 's2' },
      { type: 'turn.started', turn: 'n1' },
      { type: 'prompt', turn: 'n1', id: 'n1', text: 'fresh' },
      { type: 'live' },
    ])
    appendFileSync(join(dir, 's2.jsonl'), `${say('a1', 'in the new session')}\n`)
    await vi.waitFor(() => expect(got.live().at(-1)).toMatchObject({ text: 'in the new session' }))
    prepared.close()
  })

  it('ignores a resume for another pane, another agent or the same session', async () => {
    writeFileSync(sessionFile, `${user('u1', 'go')}\n`)
    const { streams } = fake()
    const prepared = await opened(streams)
    const got = collect(prepared)
    streams.resumed('other', { agent: 'claude', id: 's2' })
    streams.resumed('ext-1', { agent: 'codex', id: 's2' })
    streams.resumed('ext-1', { agent: 'claude', id: 's1' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(types(got.all())).not.toContain('session')
    prepared.close()
  })

  it('waits for the session id when the agent has not reported one yet', async () => {
    entry = { ...entry, agentSessionId: undefined }
    writeFileSync(sessionFile, `${user('u1', 'hi')}\n`)
    const { streams } = fake()
    const prepared = await opened(streams)
    expect(prepared.session).toBeNull()
    const got = collect(prepared)
    streams.resumed('ext-1', { agent: 'claude', id: 's1' })
    await vi.waitFor(() => expect(got.all().filter((e) => e.type === 'live')).toHaveLength(2))
    expect(types(got.all())).toEqual(['live', 'session', 'turn.started', 'prompt', 'live'])
    prepared.close()
  })
})

describe('AgentStreams, Codex', () => {
  beforeEach(() => {
    entry = { ...entry, agent: 'codex', agentSessionId: 'thread-1' }
  })

  const storedTurn = {
    id: 'u1',
    status: 'completed',
    items: [
      {
        type: 'userMessage',
        id: 'i1',
        content: [{ type: 'text', text: 'fix it', text_elements: [] }],
      },
      { type: 'agentMessage', id: 'i2', text: 'Fixed.' },
    ],
  }

  function server(f: Fake, turns: unknown[] = [storedTurn]) {
    f.rpc.request.mockImplementation(async (method: string) =>
      method === 'thread/turns/list' ? { data: [...turns].reverse() } : {},
    )
  }

  it('subscribes the thread, backfills its turns oldest first and follows its notifications', async () => {
    const f = fake()
    server(f)
    const prepared = await opened(f.streams, 3)
    expect(f.rpc.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-1',
      excludeTurns: true,
    })
    expect(f.rpc.request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      limit: 3,
      itemsView: 'full',
      sortDirection: 'desc',
    })
    expect(prepared).toMatchObject({ agent: 'codex', session: 'thread-1' })
    const got = collect(prepared)
    expect(got.all()).toEqual([
      { type: 'turn.started', turn: 'u1' },
      { type: 'prompt', turn: 'u1', id: 'i1', text: 'fix it' },
      { type: 'text', turn: 'u1', id: 'i2', text: 'Fixed.' },
      { type: 'turn.ended', turn: 'u1', status: 'done' },
      { type: 'live' },
    ])

    f.notice()('turn/started', { threadId: 'thread-1', turn: { id: 'u2' } })
    f.notice()('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'u2',
      itemId: 'i9',
      delta: 'Hel',
    })
    f.notice()('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'u2',
      itemId: 'i9',
      delta: 'lo',
    })
    expect(got.live()).toEqual([
      { type: 'turn.started', turn: 'u2' },
      { type: 'text', turn: 'u2', id: 'i9', text: 'Hel', append: true },
      { type: 'text', turn: 'u2', id: 'i9', text: 'lo', append: true },
    ])
    prepared.close()
    expect(f.rpc.close).toHaveBeenCalled()
  })

  it('ignores another thread and drops what the backfill already carried', async () => {
    const f = fake()
    server(f)
    const prepared = await opened(f.streams)
    const got = collect(prepared)
    f.notice()('turn/started', { threadId: 'other', turn: { id: 'x1' } })
    f.notice()('item/completed', {
      threadId: 'thread-1',
      turnId: 'u1',
      item: {
        type: 'userMessage',
        id: 'i1',
        content: [{ type: 'text', text: 'fix it', text_elements: [] }],
      },
    })
    f.notice()('turn/started', { threadId: 'thread-1', turn: { id: 'u1' } })
    expect(got.live()).toEqual([])
    prepared.close()
  })

  it('keeps what arrives while the backfill is still being read and sends it right after', async () => {
    const f = fake()
    f.rpc.request.mockImplementation(async (method: string) => {
      if (method === 'thread/turns/list') {
        f.notice()('turn/started', { threadId: 'thread-1', turn: { id: 'u2' } })
        return { data: [storedTurn] }
      }
      return {}
    })
    const prepared = await opened(f.streams)
    const got = collect(prepared)
    expect(got.all().at(-1)).toEqual({ type: 'turn.started', turn: 'u2' })
    prepared.close()
  })

  it('opens before the first turn exists and subscribes once the thread reports a status', async () => {
    const f = fake()
    let rollout = false
    f.rpc.request.mockImplementation(async (method: string) => {
      if (!rollout) throw new Error('no rollout found for thread id thread-1')
      return method === 'thread/turns/list' ? { data: [] } : {}
    })
    const prepared = await opened(f.streams)
    const got = collect(prepared)
    expect(got.all()).toEqual([{ type: 'live' }])
    rollout = true
    f.notice()('thread/status/changed', { threadId: 'thread-1', status: 'active' })
    await vi.waitFor(() =>
      expect(f.rpc.request.mock.calls.filter(([method]) => method === 'thread/resume').length).toBe(
        2,
      ),
    )
    prepared.close()
  })

  it('leaves out the half-written last message of a turn still running, which its deltas deliver', async () => {
    const f = fake()
    server(f, [
      {
        id: 'u1',
        status: 'inProgress',
        items: [
          {
            type: 'userMessage',
            id: 'i1',
            content: [{ type: 'text', text: 'go', text_elements: [] }],
          },
          { type: 'agentMessage', id: 'i2', text: 'Work' },
        ],
      },
    ])
    const got = collect(await opened(f.streams))
    expect(types(got.all())).toEqual(['turn.started', 'prompt', 'live'])
  })

  it('keeps trying to subscribe before the first turn exists, and sends the turns it missed once it does', async () => {
    vi.useFakeTimers()
    const f = fake()
    let rollout = false
    f.rpc.request.mockImplementation(async (method: string) => {
      if (!rollout) throw new Error('no rollout found for thread id thread-1')
      return method === 'thread/turns/list' ? { data: [storedTurn] } : {}
    })
    const got = collect(await opened(f.streams))
    expect(got.all()).toEqual([{ type: 'live' }])
    rollout = true
    await vi.advanceTimersByTimeAsync(1100)
    expect(got.live().map((e) => e.type)).toEqual(['turn.started', 'prompt', 'text', 'turn.ended'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(got.live()).toHaveLength(4)
    vi.useRealTimers()
  })

  it('ends the stream as unavailable when the thread never gets a rollout', async () => {
    vi.useFakeTimers()
    const f = fake()
    f.rpc.request.mockRejectedValue(new Error('no rollout found for thread id thread-1'))
    const got = collect(await opened(f.streams))
    await vi.advanceTimersByTimeAsync(301 * 1000)
    expect(got.live()).toEqual([{ type: 'ended', reason: 'unavailable' }])
    vi.useRealTimers()
  })

  it('says the agent closed when its app-server goes away', async () => {
    const f = fake()
    server(f)
    const got = collect(await opened(f.streams))
    f.closeRpc()
    await vi.waitFor(() => expect(got.live()).toEqual([{ type: 'ended', reason: 'agent-closed' }]))
  })

  it('refuses a pane whose app-server socket is unknown', async () => {
    const f = fake({ codexSocket: () => undefined })
    expect(await f.streams.open(pane, 5)).toEqual({ error: 'unavailable' })
  })

  it('refuses when the app-server cannot be reached, without a report', async () => {
    const warn = vi.fn()
    setErrorSink({ file: '', info: vi.fn(), warn, error: vi.fn() })
    const refused = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })
    const f = fake({ codexConnect: async () => Promise.reject(refused) })
    expect(await f.streams.open(pane, 5)).toEqual({ error: 'unavailable' })
    expect(warn).not.toHaveBeenCalled()
    setErrorSink(null)
  })

  it('refuses and reports when connecting fails in a way that is not a connection error', async () => {
    const warn = vi.fn()
    setErrorSink({ file: '', info: vi.fn(), warn, error: vi.fn() })
    const f = fake({ codexConnect: async () => Promise.reject(new TypeError('bug')) })
    expect(await f.streams.open(pane, 5)).toEqual({ error: 'unavailable' })
    expect(warn).toHaveBeenCalledWith('unexpected-error', {
      scope: 'agentStreams',
      name: 'TypeError',
      code: undefined,
    })
    setErrorSink(null)
  })
})

describe('AgentStreams, Agent pane', () => {
  beforeEach(() => {
    entry = { ...entry, kind: 'agent', agent: undefined, agentSessionId: 'a1' }
  })

  it('backfills the session from its event log and follows live events', async () => {
    const f = fake()
    f.pi.prompt('open it')
    f.pi.event({ type: 'text-delta', text: 'Ok' })
    const prepared = await opened(f.streams)
    expect(prepared).toMatchObject({ agent: 'pi', session: 'a1' })
    const got = collect(prepared)
    expect(types(got.all())).toEqual(['turn.started', 'prompt', 'text', 'live'])
    f.pi.event({ type: 'text-delta', text: '!' })
    f.pi.event({ type: 'turn-end' })
    expect(got.live()).toEqual([
      { type: 'text', turn: 't1', id: 'x2', text: '!', append: true },
      { type: 'turn.ended', turn: 't1', status: 'done' },
    ])
    prepared.close()
    f.pi.prompt('later')
    expect(got.live()).toHaveLength(2)
  })

  it('refuses a session the Agent has not opened', async () => {
    const f = fake({ pi: () => undefined })
    expect(await f.streams.open(pane, 5)).toEqual({ error: 'unavailable' })
  })
})

describe('AgentStreams, scope and lifecycle', () => {
  it('ends the stream of an agent that is no longer running in its pane', async () => {
    writeFileSync(sessionFile, `${user('u1', 'go')}\n`)
    const { streams } = fake()
    const got = collect(await opened(streams))
    await streams.agentsChanged()
    expect(got.live()).toEqual([])
    entry = { ...entry, agent: undefined }
    await streams.agentsChanged()
    expect(got.live()).toEqual([{ type: 'ended', reason: 'agent-closed' }])
  })

  it('refuses a pane that is not a running agent', async () => {
    for (const other of [
      { ...entry, agent: undefined },
      { ...entry, agent: 'other' },
      { ...entry, kind: 'agent', agentSessionId: undefined },
    ]) {
      entry = other
      expect(await fake().streams.open(pane, 5)).toEqual({ error: 'not-an-agent' })
    }
    const f = fake({ panes: async () => [] })
    expect(await f.streams.open(pane, 5)).toEqual({ error: 'not-an-agent' })
  })

  it('ends the stream when the pane closes and sends nothing after', async () => {
    writeFileSync(sessionFile, `${user('u1', 'go')}\n`)
    const { streams } = fake()
    const got = collect(await opened(streams))
    streams.paneClosed('p1')
    expect(got.live()).toEqual([{ type: 'ended', reason: 'pane-closed' }])
    appendFileSync(sessionFile, `${say('a1', 'late')}\n`)
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(got.live()).toHaveLength(1)
  })

  it('keeps one stream per subscription, each with its own turn ids', async () => {
    writeFileSync(sessionFile, `${user('u1', 'go')}\n`)
    const { streams } = fake()
    const a = collect(await opened(streams))
    const b = collect(await opened(streams))
    expect(a.all()).toEqual(b.all())
    streams.paneClosed('p1')
    expect(a.live()).toHaveLength(1)
    expect(b.live()).toHaveLength(1)
  })

  describe('permission prompts', () => {
    const ask = (askId: string, paneId = 'ext-1'): Ask => ({
      askId,
      sessionId: 'w1',
      paneId,
      kind: 'permission',
      title: 'Bash: git push',
      choices: [],
      allowText: false,
      since: 1,
    })

    it('carries a reference to a prompt already open, one that opens later and its resolution', async () => {
      writeFileSync(sessionFile, `${user('u1', 'go')}\n`)
      const f = fake()
      f.asks.push(ask('question-1'), ask('question-9', 'someone-else'))
      const prepared = await opened(f.streams)
      const got = collect(prepared)
      expect(got.all()).toEqual([
        { type: 'turn.started', turn: 'u1' },
        { type: 'prompt', turn: 'u1', id: 'u1', text: 'go' },
        { type: 'ask', askId: 'question-1', kind: 'permission' },
        { type: 'live' },
      ])
      f.streams.askOpened(ask('question-2'))
      f.streams.askOpened(ask('question-3', 'someone-else'))
      f.streams.askResolved({ askId: 'question-2', outcome: 'answered' })
      f.streams.askResolved({ askId: 'question-9', outcome: 'answered' })
      f.streams.askResolved({ askId: 'question-1', outcome: 'timeout' })
      expect(got.live()).toEqual([
        { type: 'ask', askId: 'question-2', kind: 'permission' },
        { type: 'ask.resolved', askId: 'question-2', outcome: 'answered' },
        { type: 'ask.resolved', askId: 'question-1', outcome: 'timeout' },
      ])
      prepared.close()
    })
  })
})
