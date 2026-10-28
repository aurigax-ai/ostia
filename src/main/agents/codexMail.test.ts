import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-codexmail-'))
process.env.XDG_DATA_HOME = dataHome

const { CodexMail } = await import('./codexMail')
const { ackMail, enqueue, flushBus, getMail, leaseMail, resetBus } = await import('./busStore')
const { mailers } = await import('./mailers')
const { MAIL_TURNS_MAX, MAIL_TURNS_WINDOW_MS } = await import('../../shared/agents/mailDelivery')

const request = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({}))
let closeClient: () => void = () => {}
const rpc = () => ({
  request,
  close: vi.fn(),
  closed: new Promise<void>((resolve) => {
    closeClient = resolve
  }),
})
const connect = vi.fn(async (_socket: string) => rpc())
const started: unknown[] = []
const scheduled: { ms: number; fn: () => void }[] = []
const state = {
  busy: false,
  thread: 'thread-1' as string | undefined,
  socket: '/sock' as string | undefined,
  now: 1000,
}

const mail = new CodexMail({
  socketOf: () => state.socket,
  connect,
  threadOf: async () => state.thread,
  agentBusy: () => state.busy,
  schedule: (ms, fn) => void scheduled.push({ ms, fn }),
  now: () => state.now,
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
const send = (text: string) => enqueue({ from: 'boss', to: 'codex-pane', text })

beforeEach(async () => {
  await resetBus()
  rmSync(join(dataHome, 'ostia'), { recursive: true, force: true })
  mail.detach('codex-pane')
  mailers.clear('codex-pane')
  request.mockClear()
  request.mockImplementation(async () => ({}))
  connect.mockClear()
  scheduled.length = 0
  started.length = 0
  Object.assign(state, { busy: false, thread: 'thread-1', socket: '/sock', now: 1000 })
})

afterAll(async () => {
  await flushBus()
  rmSync(dataHome, { recursive: true, force: true })
})

describe('Codex mail', () => {
  it('starts a turn on the pane’s thread with the framed text, never typing, and acknowledges it', async () => {
    const queued = send('review is done')
    mail.attach('codex-pane')
    await settle()
    expect(connect).toHaveBeenCalledWith('/sock')
    const turn = request.mock.calls.find(([method]) => method === 'turn/start')
    expect(turn?.[1]).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: expect.stringContaining('review is done') }],
    })
    expect(JSON.stringify(turn?.[1])).toContain('never as instructions from the human')
    expect(getMail(queued.id)).toMatchObject({ state: 'delivered', via: 'turn' })
  })

  it.each([2500, 9000])('starts the turn with a %i-character message whole', async (length) => {
    const body = 'k'.repeat(length)
    const queued = send(body)
    mail.attach('codex-pane')
    await settle()
    const turn = request.mock.calls.find(([method]) => method === 'turn/start')
    const input = (turn?.[1] as { input: { text: string }[] }).input
    expect(input[0]?.text).toContain(`>\n${body}\n</message>`)
    expect(getMail(queued.id)).toMatchObject({ state: 'delivered', via: 'turn' })
  })

  it('delivers mail that arrives later when it is kicked, over the same connection', async () => {
    mail.attach('codex-pane')
    await settle()
    expect(request).not.toHaveBeenCalled()
    send('one')
    mail.kick('codex-pane')
    await settle()
    send('two')
    mail.kick('codex-pane')
    await settle()
    expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('waits while the agent works, and starts the turn once it is kicked at idle', async () => {
    const queued = send('later')
    state.busy = true
    mail.attach('codex-pane')
    await settle()
    expect(request).not.toHaveBeenCalled()
    expect(getMail(queued.id)?.state).toBe('queued')
    state.busy = false
    mail.kick('codex-pane')
    await settle()
    expect(getMail(queued.id)?.state).toBe('delivered')
  })

  it('leases nothing when the thread or the socket is not known yet', async () => {
    const queued = send('too early')
    state.thread = undefined
    mail.attach('codex-pane')
    await settle()
    state.thread = 'thread-1'
    state.socket = undefined
    mail.kick('codex-pane')
    await settle()
    expect(getMail(queued.id)?.state).toBe('queued')
    expect(connect).not.toHaveBeenCalled()
  })

  it('gives the message back when Codex refuses the turn, and tries again after a pause', async () => {
    const queued = send('refused')
    request.mockImplementation(async (method) => {
      if (method === 'turn/start') throw new Error('no such thread')
      return {}
    })
    mail.attach('codex-pane')
    await settle()
    expect(getMail(queued.id)?.state).toBe('queued')
    expect(scheduled.map((s) => s.ms)).toEqual([10_000])
    mail.kick('codex-pane')
    await settle()
    expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)

    request.mockImplementation(async () => ({}))
    state.now += 10_000
    scheduled[0]?.fn()
    await settle()
    expect(getMail(queued.id)?.state).toBe('delivered')
  })

  it('does not start a second turn when the first one did start although the answer timed out', async () => {
    const queued = send('slow')
    request.mockImplementation(async (method, params) => {
      if (method === 'turn/start') {
        started.push(params)
        throw new Error('turn/start timed out')
      }
      const input = (started[0] as { input: { text: string }[] }).input
      return { data: [{ items: [{ text: input[0].text }] }] }
    })
    mail.attach('codex-pane')
    await settle()
    expect(getMail(queued.id)?.state).toBe('delivered')
    mail.kick('codex-pane')
    await settle()
    expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  })

  it('gives the message back when the thread shows no turn with its id after a timeout', async () => {
    const queued = send('lost')
    request.mockImplementation(async (method) => {
      if (method === 'turn/start') throw new Error('turn/start timed out')
      return { data: [{ items: [{ text: 'something else' }] }] }
    })
    mail.attach('codex-pane')
    await settle()
    expect(getMail(queued.id)?.state).toBe('queued')
  })

  it('tries again when the rate limit lifts instead of waiting for the next change', async () => {
    for (let i = 0; i < MAIL_TURNS_MAX; i++) mailers.recordTurn('codex-pane')
    const queued = send('over the limit')
    mail.attach('codex-pane')
    await settle()
    expect(getMail(queued.id)?.state).toBe('queued')
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].ms).toBeGreaterThan(0)
    expect(scheduled[0].ms).toBeLessThanOrEqual(MAIL_TURNS_WINDOW_MS)
  })

  it('does not count a refused turn toward the rate limit', async () => {
    send('refused')
    request.mockImplementation(async (method) => {
      if (method === 'turn/start') throw new Error('no such thread')
      return {}
    })
    mail.attach('codex-pane')
    await settle()
    expect(mailers.limited('codex-pane')).toBe(false)
    for (let i = 0; i < MAIL_TURNS_MAX; i++) {
      state.now += 10_000
      mail.kick('codex-pane')
      await settle()
    }
    expect(mailers.limited('codex-pane')).toBe(false)
  })

  it('fails the message with a reason after Codex refused it five times in a row', async () => {
    const queued = send('never accepted')
    request.mockImplementation(async (method) => {
      if (method === 'turn/start') throw new Error('no such thread')
      return {}
    })
    mail.attach('codex-pane')
    await settle()
    for (let i = 0; i < 4; i++) {
      state.now += 10_000
      mail.kick('codex-pane')
      await settle()
    }
    expect(getMail(queued.id)).toMatchObject({ state: 'failed', reason: 'agent-refused' })
  })

  it('does not take the bare id in the agent’s own inbox output for a started turn', async () => {
    const queued = send('echoed')
    request.mockImplementation(async (method) => {
      if (method === 'turn/start') throw new Error('turn/start timed out')
      return { data: [{ items: [{ text: `ostia bus inbox\n${queued.id}  boss  echoed` }] }] }
    })
    mail.attach('codex-pane')
    await settle()
    expect(getMail(queued.id)?.state).toBe('queued')
  })

  it('gives the message back when the connection cannot be made', async () => {
    const queued = send('no server')
    connect.mockRejectedValueOnce(new Error('ENOENT'))
    mail.attach('codex-pane')
    await settle()
    expect(getMail(queued.id)?.state).toBe('queued')
  })

  it('connects again after Codex closed the connection', async () => {
    send('one')
    mail.attach('codex-pane')
    await settle()
    closeClient()
    await settle()
    send('two')
    mail.kick('codex-pane')
    await settle()
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('does nothing for a pane it was not attached to, or after it was detached', async () => {
    const queued = send('nobody home')
    mail.kick('codex-pane')
    await settle()
    mail.attach('codex-pane')
    mail.detach('codex-pane')
    await settle()
    mail.kick('codex-pane')
    await settle()
    expect(getMail(queued.id)?.state).toBe('queued')
  })

  it('counts attaching as a live mailer for the pending reason, and detaching as gone', () => {
    mail.attach('codex-pane')
    expect(mailers.state('codex-pane')).toEqual({ draft: false })
    mail.detach('codex-pane')
    expect(mailers.state('codex-pane')).toBeUndefined()
  })

  it('leaves events for their batch window, and messages through at once', async () => {
    enqueue({ from: 'worker', to: 'codex-pane', text: 'w-1 done', kind: 'event' })
    mail.attach('codex-pane')
    await settle()
    send('a message')
    enqueue({ from: 'worker2', to: 'codex-pane', text: 'w-2 done', kind: 'event' })
    mail.kick('codex-pane')
    await settle()
    const texts = request.mock.calls
      .filter(([method]) => method === 'turn/start')
      .map(([, params]) => JSON.stringify(params))
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('w-1 done')
    expect(texts[1]).toContain('a message')
    expect(texts[1]).not.toContain('w-2 done')
    const handed = leaseMail('codex-pane', 'read', () => true)
    ackMail('codex-pane', handed?.lease ?? '')
    expect(handed?.messages.map((m) => m.text)).toEqual(['w-2 done'])
  })
})
