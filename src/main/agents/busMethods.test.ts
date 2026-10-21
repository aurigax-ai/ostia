import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailPending } from '../../shared/agents/busMessages'
import type { ControlMethod, ControlMethodContext } from '../control/controlServer'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-bus-'))
process.env.XDG_DATA_HOME = dataHome

const methods = new Map<string, ControlMethod>()
vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, method: ControlMethod) => methods.set(name, method),
}))
const held = new Set<string>()
vi.mock('../control/controlAuth', async (original) => ({
  ...(await original<typeof import('../control/controlAuth')>()),
  connHasCap: (_conn: unknown, cap: string) => held.has(cap),
}))
const ensureCaps = vi.fn(async (..._args: unknown[]) => {})
vi.mock('../approvals/controlElevation', () => ({ ensureCaps }))

const { registerBusMethods } = await import('./busMethods')
const {
  INBOX_MAX,
  MAIL_TTL_MS,
  failPaneMail,
  flushBus,
  onMailQueued,
  postBusMessage,
  postEvent,
  resetBus,
} = await import('./busStore')
const { mailers } = await import('./mailers')
const { EVENT_BATCH_MS, MAIL_TURNS_MAX } = await import('../../shared/agents/mailDelivery')
const { markManager, registerPane, registerScript, removePane } = await import(
  '../control/idRegistry'
)
const { rememberClosedPane } = await import('../panes/closedPanes')

const queuedWakes: Array<boolean | undefined> = []
onMailQueued((mail) => queuedWakes.push(mail.wakes))
const announce = vi.fn()
const observed = vi.fn()
let managerMaySend = true
const pendingByPane = new Map<string, MailPending>()
const scriptReaches = new Set<string>()
const scopeReaches = new Set<string>()
const busyPanes = new Set<string>()
const sandboxed = new Set<string>()
const confined = new Set<string>()
const owned = new Set<string>()
const named = new Map<string, string[]>()
registerBusMethods({
  managerSendAllowed: () => managerMaySend,
  agentBusy: (pane) => busyPanes.has(pane.paneId),
  announce,
  observe: observed,
  pending: async (pane) => pendingByPane.get(pane.paneId) ?? 'idle-no-wake',
  reach: {
    processPane: async (ref) => named.get(ref) ?? [],
    visible: async () => (workspaceId) => scopeReaches.has(workspaceId),
    inScope: async (ctx, workspaceId) =>
      ctx.identity.kind === 'script'
        ? scriptReaches.has(workspaceId)
        : ctx.identity.workspaceId === workspaceId || scopeReaches.has(workspaceId),
    isChild: (owner, paneId) => owned.has(`${owner}>${paneId}`),
    isSandboxed: (workspaceId) => sandboxed.has(workspaceId),
    isConfined: (paneId) => confined.has(paneId),
  },
})

const sender = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'bus-sender' })
const receiver = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'bus-receiver' })
const faraway = registerPane({ windowId: 'w1', workspaceId: 'ws9', paneId: 'bus-faraway' })

type Closer = () => void

function contextOf(identity: typeof sender, closers: Closer[] = []): ControlMethodContext {
  return {
    identity,
    authed: {},
    conn: {
      onClose: (fn: Closer) => {
        closers.push(fn)
        return { dispose: () => closers.splice(closers.indexOf(fn), 1) }
      },
    },
  } as unknown as ControlMethodContext
}

function call<T>(name: string, identity: typeof sender, params?: unknown, closers?: Closer[]): T {
  const method = methods.get(name)
  if (!method) throw new Error(`no method ${name}`)
  return method.handler(params, contextOf(identity, closers)) as T
}

interface Wire {
  id: string
  text: string
  state: string
  kind: string
  from: string
  task?: true
}
interface Sent {
  id: string
  to: string
  preview: string
  state: string
  via?: string
  reason?: string
  pending?: string
}
interface Answer {
  ok: boolean
  id?: string
  state?: string
  pending?: string
  via?: string
  error?: string
}
interface Waited {
  messages: Wire[]
  timedOut: boolean
  lease?: string
}

function inbox(identity = receiver, take = false): Wire[] {
  const res = call<{ messages: Wire[]; lease?: string }>('bus.inbox', identity, { take })
  if (res.lease) call('bus.ack', identity, { lease: res.lease })
  return res.messages
}
const sent = (identity = sender) =>
  call<Promise<{ messages: Sent[] }>>('bus.sent', identity).then((res) => res.messages)
const send = (text: string, to = receiver.externalId, from = sender, extra = {}) =>
  call<Promise<Answer>>('bus.send', from, { to, text, ...extra })
const context = (identity = receiver, event = 'UserPromptSubmit') =>
  call<{ text: string | null; lease?: string }>('bus.context', identity, { event })
const ack = (lease: string | undefined, identity = receiver) =>
  call<{ acked: number }>('bus.ack', identity, { lease }).acked

beforeEach(async () => {
  await resetBus()
  rmSync(join(dataHome, 'ostia'), { recursive: true, force: true })
  announce.mockClear()
  queuedWakes.length = 0
  held.clear()
  owned.clear()
  named.clear()
  observed.mockClear()
  ensureCaps.mockClear()
  ensureCaps.mockImplementation(async () => {})
  managerMaySend = true
  pendingByPane.clear()
  scriptReaches.clear()
  scopeReaches.clear()
  sandboxed.clear()
  confined.clear()
})

afterAll(async () => {
  await flushBus()
  rmSync(dataHome, { recursive: true, force: true })
})

describe('bus.send', () => {
  it('queues a message, says why it waits, and tells the human', async () => {
    pendingByPane.set('bus-receiver', 'working')
    const res = await send('tests are green')
    expect(res).toMatchObject({ ok: true, state: 'queued', pending: 'working' })
    expect(announce).toHaveBeenCalledWith(sender, receiver, 'tests are green')
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      sender,
      ['send-other-pane'],
      'bus.send',
      `to ${receiver.externalId}`,
    )
    expect(inbox().map((m) => m.text)).toEqual(['tests are green'])
  })

  it('answers what the store holds, not what was asked', async () => {
    const res = await send('check me')
    const [row] = await sent()
    expect(row).toMatchObject({ id: res.id, state: res.state, preview: 'check me' })
  })

  it('hands a message straight to a pane blocked in bus wait', async () => {
    const waiting = call<Promise<Waited>>('bus.wait', receiver, { timeoutMs: 5000 })
    const res = await send('wake up')
    expect(res).toMatchObject({ ok: true, state: 'leased' })
    expect(res).not.toHaveProperty('pending')
    expect(announce).not.toHaveBeenCalled()
    const woken = await waiting
    expect(woken.timedOut).toBe(false)
    expect(woken.messages.map((m) => m.text)).toEqual(['wake up'])
    ack(woken.lease)
    expect((await sent())[0]).toMatchObject({ state: 'delivered', via: 'read' })
  })

  it('keeps a message handed to bus wait when the client dies before it acknowledges', async () => {
    const closers: Closer[] = []
    const waiting = call<Promise<Waited>>('bus.wait', receiver, { timeoutMs: 5000 }, closers)
    await send('do not lose me')
    expect((await waiting).messages.map((m) => m.text)).toEqual(['do not lose me'])
    for (const close of [...closers]) close()
    expect(inbox()).toMatchObject([{ text: 'do not lose me', state: 'queued' }])
    expect((await sent())[0]).toMatchObject({ state: 'queued' })
  })

  it('keeps messages taken from the inbox when the client dies before it acknowledges', async () => {
    await send('still here')
    const closers: Closer[] = []
    const taken = call<{ messages: Wire[]; lease?: string }>(
      'bus.inbox',
      receiver,
      { take: true },
      closers,
    )
    expect(taken.lease).toBeDefined()
    for (const close of [...closers]) close()
    expect(inbox()).toMatchObject([{ text: 'still here', state: 'queued' }])
  })

  it('queues again once the waiting command lost its connection', async () => {
    const closers: Closer[] = []
    const waiting = call<Promise<Waited>>('bus.wait', receiver, { timeoutMs: 5000 }, closers)
    for (const close of [...closers]) close()
    expect((await waiting).timedOut).toBe(true)
    expect((await send('anyone?')).state).toBe('queued')
  })

  it('refuses a receiver no open pane holds, before asking the human for anything', async () => {
    const res = await send('hello', '00000000-0000-0000-0000-000000000000')
    expect(res).toMatchObject({ ok: false, error: 'unknown-pane' })
    expect(ensureCaps).not.toHaveBeenCalled()
    expect(await sent()).toEqual([])
  })

  it('stores nothing and announces nothing when the human denies the capability', async () => {
    ensureCaps.mockRejectedValueOnce(new Error('denied: send-other-pane'))
    await expect(send('psst')).rejects.toThrow('denied: send-other-pane')
    expect(inbox()).toEqual([])
    expect(announce).not.toHaveBeenCalled()
  })

  it('sends to itself without a capability or an announcement', async () => {
    const res = await send('note to self', sender.externalId)
    expect(res.state).toBe('queued')
    expect(ensureCaps.mock.calls.every((c) => (c[2] as string[]).length === 0)).toBe(true)
    expect(announce).not.toHaveBeenCalled()
  })

  it('refuses a missing or empty text', async () => {
    await expect(send('')).rejects.toThrow('bad-request: text')
  })

  it('still holds the manager to its bus limit', async () => {
    const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'bus-manager' })
    markManager('bus-manager')
    managerMaySend = false
    await expect(send('go', receiver.externalId, manager)).rejects.toThrow('limit:')
    expect(inbox()).toEqual([])
  })

  it('refuses a receiver with 200 undelivered messages instead of dropping the oldest', async () => {
    for (let i = 0; i < INBOX_MAX; i++)
      postBusMessage(sender.externalId, receiver.externalId, `${i}`)
    expect(await send('one more')).toMatchObject({ ok: false, error: 'inbox-full' })
    expect(inbox()).toHaveLength(INBOX_MAX)
  })

  it('expires an undelivered message after 24 hours with the reason it waited', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      pendingByPane.set('bus-receiver', 'hibernated')
      await send('too late')
      vi.setSystemTime(Date.now() + MAIL_TTL_MS + 1000)
      const [row] = await sent()
      expect(row).toMatchObject({ state: 'failed', reason: 'expired:hibernated' })
      expect(inbox()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails the message of a pane that closed', async () => {
    await send('are you there')
    failPaneMail(receiver.externalId)
    expect((await sent())[0]).toMatchObject({ state: 'failed', reason: 'pane-closed' })
  })
})

describe('bus.send --wait', () => {
  const reply = (text: string, from = receiver, to = sender) =>
    send(text, to.externalId, from).then((res) => res.id)

  it('answers the first message the receiver sends back and takes only that one', async () => {
    const waiting = send('status?', receiver.externalId, sender, { waitMs: 5000 })
    await vi.waitFor(() => expect(inbox()).toHaveLength(1))
    await send('not from the receiver', sender.externalId, faraway)
    await reply('all green')
    const res = (await waiting) as Answer & { reply?: { messages: Wire[]; lease: string } }
    expect(res).toMatchObject({ ok: true, state: 'queued' })
    expect(res.reply?.messages.map((m) => m.text)).toEqual(['all green'])
    ack(res.reply?.lease, sender)
    expect(inbox(sender).map((m) => m.text)).toEqual(['not from the receiver'])
  })

  it('answers a reply that is queued already by the time it looks, but not an older message', async () => {
    await reply('an older note')
    const waiting = send('status?', receiver.externalId, sender, { waitMs: 5000 })
    await vi.waitFor(() => expect(inbox()).toHaveLength(1))
    await reply('the answer')
    const res = (await waiting) as { reply?: { messages: Wire[] } }
    expect(res.reply?.messages.map((m) => m.text)).toEqual(['the answer'])
  })

  it('refuses a second wait for the same sender and receiver before sending anything', async () => {
    const first = send('one?', receiver.externalId, sender, { waitMs: 5000 })
    await vi.waitFor(() => expect(inbox()).toHaveLength(1))
    expect(await send('two?', receiver.externalId, sender, { waitMs: 5000 })).toMatchObject({
      ok: false,
      error: 'busy',
    })
    expect(inbox()).toHaveLength(1)
    await reply('answer')
    expect(await first).toMatchObject({ ok: true })
  })

  it('lets only one of two concurrent waits to the same pane through', async () => {
    const results = await Promise.all([
      send('one?', receiver.externalId, sender, { waitMs: 1000 }),
      send('two?', receiver.externalId, sender, { waitMs: 1000 }),
      (async () => {
        await vi.waitFor(() => expect(inbox()).toHaveLength(1))
        await reply('answer')
        return undefined
      })(),
    ])
    const [first, second] = results as Answer[]
    expect([first.error, second.error].sort()).toEqual(['busy', undefined])
    expect(inbox()).toHaveLength(1)
  })

  it('gives the reply to the waiting send, not to an earlier plain bus wait of the sender', async () => {
    const plain = call<Promise<Waited>>('bus.wait', sender, { timeoutMs: 5000 })
    const waiting = send('status?', receiver.externalId, sender, { waitMs: 5000 })
    await vi.waitFor(() => expect(inbox()).toHaveLength(1))
    await reply('the answer')
    const res = (await waiting) as { reply?: { messages: Wire[] } }
    expect(res.reply?.messages.map((m) => m.text)).toEqual(['the answer'])
    await reply('later note')
    expect((await plain).messages.map((m) => m.text)).toEqual(['later note'])
  })

  it('does not take an event about the receiver for its reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const waiting = send('status?', receiver.externalId, sender, { waitMs: 1000 })
      await vi.advanceTimersByTimeAsync(10)
      postEvent(receiver.externalId, sender.externalId, 'w-1 done')
      await vi.advanceTimersByTimeAsync(1000)
      expect(await waiting).not.toHaveProperty('reply')
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers failed at once when the receiver’s pane closes', async () => {
    const waiting = send('read this', receiver.externalId, sender, { waitMs: 5000 })
    await vi.waitFor(() => expect(inbox()).toHaveLength(1))
    failPaneMail(receiver.externalId)
    expect(await waiting).toMatchObject({ ok: true, state: 'failed', reason: 'pane-closed' })
  })

  it('answers the observed state, queued with its reason, when no reply comes in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      pendingByPane.set('bus-receiver', 'idle-no-wake')
      const waiting = send('slow', receiver.externalId, sender, { waitMs: 1000 })
      await vi.advanceTimersByTimeAsync(1000)
      const res = await waiting
      expect(res).toMatchObject({ ok: true, state: 'queued', pending: 'idle-no-wake' })
      expect(res).not.toHaveProperty('reply')
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces the question before it waits, and releases a reply the client never acknowledged', async () => {
    const closers: Closer[] = []
    const waiting = call<Promise<Answer & { reply?: { lease: string } }>>(
      'bus.send',
      sender,
      { to: receiver.externalId, text: 'status?', waitMs: 5000 },
      closers,
    )
    await vi.waitFor(() => expect(announce).toHaveBeenCalledWith(sender, receiver, 'status?'))
    await reply('done')
    const res = await waiting
    expect(res.reply?.lease).toBeDefined()
    for (const close of [...closers]) close()
    expect(inbox(sender).map((m) => m.text)).toEqual(['done'])
  })
})

describe('naming the receiver', () => {
  it('takes the first 8 characters of its id and a process name', async () => {
    expect(await send('by prefix', receiver.externalId.slice(0, 8))).toMatchObject({
      ok: true,
      state: 'queued',
    })
    named.set('w-1', ['bus-receiver'])
    expect(await send('by name', 'w-1')).toMatchObject({ ok: true, state: 'queued' })
    expect(inbox().map((m) => m.text)).toEqual(['by prefix', 'by name'])
  })

  it('answers ambiguous-pane with the ids instead of choosing, and says what closed', async () => {
    const twin = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'bus-twin' })
    twin.externalId = `${receiver.externalId.slice(0, 8)}-ffff-4fff-8fff-ffffffffffff`
    const res = await send('which?', receiver.externalId.slice(0, 8))
    expect(res).toMatchObject({ ok: false, error: 'ambiguous-pane' })
    expect((res as { message?: string }).message).toContain(twin.externalId)
    removePane('bus-twin')
    rememberClosedPane({
      externalId: 'e6546de6-0000-4000-8000-000000000000',
      workspaceId: 'ws1',
      name: 'w-1241',
      closedAt: Date.now() - 7_200_000,
    })
    expect(await send('gone?', 'e6546de6')).toMatchObject({
      ok: false,
      error: 'unknown-pane',
      message: expect.stringContaining('closed 2h ago (w-1241)'),
    })
  })

  it('never reaches a pane outside the caller’s reach by a prefix', async () => {
    const res = await send('hello', faraway.externalId.slice(0, 8))
    expect(res).toMatchObject({ ok: false, error: 'unknown-pane' })
  })
})

describe('who may send', () => {
  it('asks for all-workspaces from a pane outside the receiver’s reach', async () => {
    await send('far', faraway.externalId)
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      sender,
      ['send-other-pane', 'all-workspaces'],
      'bus.send',
      `to ${faraway.externalId}`,
    )
  })

  it('needs only send-other-pane for a pane within reach', async () => {
    scopeReaches.add('ws9')
    await send('near', faraway.externalId)
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      sender,
      ['send-other-pane'],
      'bus.send',
      `to ${faraway.externalId}`,
    )
  })

  it('lets a sandboxed pane reach only a confined pane of its own workspace', async () => {
    sandboxed.add('ws1')
    await expect(send('out', faraway.externalId)).rejects.toThrow('sandboxed')
    await expect(send('same workspace, not confined')).rejects.toThrow('sandboxed')
    confined.add('bus-receiver')
    expect((await send('in')).state).toBe('queued')
    expect(inbox().map((m) => m.text)).toEqual(['in'])
  })

  it('lets a pane answer the manager pane with send-other-pane only, but never a sandboxed one', async () => {
    const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'bus-manager-1' })
    markManager('bus-manager-1')
    owned.add(`${manager.paneId}>${sender.paneId}`)
    expect((await send('done', manager.externalId)).state).toBe('queued')
    expect(ensureCaps).toHaveBeenLastCalledWith(
      {},
      sender,
      ['send-other-pane'],
      'bus.send',
      `to ${manager.externalId}`,
    )
    sandboxed.add('ws1')
    await expect(send('done', manager.externalId)).rejects.toThrow('sandboxed')
  })

  it('asks all-workspaces of a pane the manager did not start before it may mail the manager', async () => {
    const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'bus-manager-4' })
    markManager('bus-manager-4')
    await send('hello', manager.externalId)
    expect(ensureCaps).toHaveBeenLastCalledWith(
      {},
      sender,
      ['send-other-pane', 'all-workspaces'],
      'bus.send',
      `to ${manager.externalId}`,
    )
  })

  it('stores nothing for a handoff that is out of reach', async () => {
    sandboxed.add('ws1')
    await expect(
      call<Promise<unknown>>('bus.handoff', sender, {
        to: faraway.externalId,
        task: 't',
        summary: 's',
      }),
    ).rejects.toThrow('sandboxed')
    expect(inbox(faraway)).toEqual([])
    const listed = await call<Promise<{ handoffs: unknown[] }>>('bus.handoffs', sender, {})
    expect(listed.handoffs).toEqual([])
  })
})

describe('bus.send from a script token', () => {
  const script = registerScript('script_bus')

  it('is open to script tokens and delivers with send-other-pane and all-workspaces', async () => {
    expect(methods.get('bus.send')?.scripts).toBe(true)
    const res = await send('next task', receiver.externalId, script)
    expect(res).toMatchObject({ ok: true, state: 'queued' })
    expect(inbox().map((m) => m.text)).toEqual(['next task'])
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      script,
      ['send-other-pane', 'all-workspaces'],
      'bus.send',
      `to ${receiver.externalId}`,
    )
  })

  it('needs only send-other-pane for a receiver in the token scope', async () => {
    scriptReaches.add('ws1')
    await send('in scope', receiver.externalId, script)
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      script,
      ['send-other-pane'],
      'bus.send',
      `to ${receiver.externalId}`,
    )
  })

  it('stores nothing when the token lacks a capability', async () => {
    ensureCaps.mockRejectedValueOnce(new Error('needs-elevation: all-workspaces'))
    await expect(send('psst', receiver.externalId, script)).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    expect(inbox()).toEqual([])
  })

  it('must name a receiver, and never reaches the manager pane', async () => {
    await expect(send('x', '', script)).rejects.toThrow('bad-request: to')
    const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'bus-manager-2' })
    markManager('bus-manager-2')
    expect(await send('x', manager.externalId, script)).toMatchObject({
      ok: false,
      error: 'unknown-pane',
    })
    expect(ensureCaps).not.toHaveBeenCalled()
  })
})

describe('reading the inbox', () => {
  it('lists messages without delivering them, so a human or agent looking is not a receipt', async () => {
    await send('look but do not touch')
    expect(inbox().map((m) => m.state)).toEqual(['queued'])
    expect(inbox().map((m) => m.state)).toEqual(['queued'])
    expect((await sent())[0]).toMatchObject({ state: 'queued' })
    expect(context().text).toContain('look but do not touch')
  })

  it('delivers on take, once, and the sender sees how', async () => {
    await send('read me')
    expect(inbox(receiver, true).map((m) => m.text)).toEqual(['read me'])
    expect(inbox(receiver, true)).toEqual([])
    expect(inbox()).toEqual([])
    expect((await sent())[0]).toMatchObject({ state: 'delivered', via: 'read' })
  })

  it('waits only for a message it has not taken', async () => {
    await send('old news')
    const first = await call<Promise<Waited>>('bus.wait', receiver, { timeoutMs: 1000 })
    expect(first.messages.map((m) => m.text)).toEqual(['old news'])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const second = call<Promise<Waited>>('bus.wait', receiver, { timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(await second).toEqual({ messages: [], timedOut: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists a pane only what it sent itself, as a clipped one-line preview', async () => {
    await send(`line one \x1b[31m${'z'.repeat(300)}\nline two`)
    await send('from the other side', sender.externalId, receiver)
    const mine = await sent()
    expect(mine).toHaveLength(1)
    expect(mine[0]?.preview).toHaveLength(120)
    expect(mine[0]?.preview).not.toContain('\x1b')
    expect(mine[0]?.preview).not.toContain('line two')
    expect((await sent(receiver)).map((m) => m.preview)).toEqual(['from the other side'])
  })
})

describe('hook context', () => {
  it('leases the shown messages, delivers them on ack as the prompt, and shows them once', async () => {
    await send('first')
    await send('second')
    const shown = context()
    expect(shown.text).toContain('2 unread messages')
    expect(shown.text).toContain('first')
    expect(shown.text).toContain('second')
    expect(shown.text).toMatch(/<message id="[A-Za-z0-9-]+" from=/)
    expect(context().text).toBeNull()
    expect((await sent()).map((m) => m.state)).toEqual(['leased', 'leased'])

    expect(ack(shown.lease)).toBe(2)
    expect(ack(shown.lease)).toBe(0)
    expect((await sent()).map((m) => [m.state, m.via])).toEqual([
      ['delivered', 'prompt'],
      ['delivered', 'prompt'],
    ])
    expect(inbox()).toEqual([])
  })

  it('records a session start as the way the message arrived', async () => {
    await send('welcome back')
    ack(context(receiver, 'SessionStart').lease)
    expect((await sent())[0]).toMatchObject({ state: 'delivered', via: 'start' })
  })

  it('refuses an acknowledgement from another pane', async () => {
    await send('mine')
    const { lease } = context()
    expect(ack(lease, sender)).toBe(0)
    expect((await sent())[0]?.state).toBe('leased')
  })

  it('adds nothing for an empty inbox', () => {
    expect(context()).toEqual({ text: null })
  })

  it('leaves messages that did not fit queued, so the next prompt shows them', async () => {
    for (let i = 0; i < 6; i++) await send(`${i}`.repeat(2500))
    const first = context()
    expect(first.text).toContain('2 unread messages')
    expect(first.text).toContain('4 more not shown here')
    ack(first.lease)
    expect((await sent()).filter((m) => m.state === 'delivered')).toHaveLength(2)
    const second = context()
    expect(second.text).toContain('2 unread messages')
    expect(second.text).toContain('2 more not shown here')
    ack(second.lease)
    const third = context()
    expect(third.text).toContain('2 unread messages')
    expect(third.text).not.toContain('more not shown here')
    ack(third.lease)
    expect(context().text).toBeNull()
  })

  it('delivers a 2,500-character message whole', async () => {
    const body = 'a'.repeat(2500)
    await send(body)
    const shown = context()
    expect(shown.text).toContain(`>\n${body}\n</message>`)
    ack(shown.lease)
    expect((await sent())[0]?.state).toBe('delivered')
  })

  it('never acks a 9,000-character message: it stays queued, the prompt only says it waits, and bus inbox reads it whole', async () => {
    const body = 'b'.repeat(9000)
    await send(body)
    const notice = context()
    expect(notice.lease).toBeUndefined()
    expect(notice.text).toContain('1 unread message')
    expect(notice.text).not.toContain('bbbb')
    expect(notice.text).toContain('ostia bus inbox --take')
    expect(context().text).toBe(notice.text)
    expect((await sent())[0]?.state).toBe('queued')
    expect(inbox().map((m) => m.text)).toEqual([body])
    expect(inbox(receiver, true).map((m) => m.text)).toEqual([body])
    expect((await sent())[0]).toMatchObject({ state: 'delivered', via: 'read' })
    expect(context().text).toBeNull()
  })

  it('shows the messages before a too long one and keeps it and the ones after it queued, in order', async () => {
    const body = 'c'.repeat(9000)
    await send('short one')
    await send(body)
    await send('overtaker')
    const shown = context()
    expect(shown.text).toContain('short one')
    expect(shown.text).toContain('2 more not shown here')
    expect(shown.text).not.toContain('cccc')
    expect(shown.text).not.toContain('overtaker')
    ack(shown.lease)
    expect((await sent()).map((m) => m.state)).toEqual(['delivered', 'queued', 'queued'])
    expect(inbox().map((m) => m.text)).toEqual([body, 'overtaker'])
  })
})

const take = (identity = receiver) =>
  call<{ text?: string; lease?: string; busy?: true; limited?: true; retryMs?: number }>(
    'bus.take',
    identity,
  )

describe('bus.take for the mod', () => {
  beforeEach(() => {
    mailers.clear(receiver.externalId)
    busyPanes.clear()
  })

  it('leases the queued messages and answers their framed text and a lease, then delivers as a turn on ack', async () => {
    await send('first')
    await send('second')
    const taken = take()
    expect(taken.text).toContain('2 unread messages')
    expect(taken.text).toContain('first')
    expect(taken.lease).toBeTruthy()
    expect((await sent()).map((m) => m.state)).toEqual(['leased', 'leased'])
    expect(take()).toEqual({})
    expect(ack(taken.lease)).toBe(2)
    expect((await sent()).map((m) => [m.state, m.via])).toEqual([
      ['delivered', 'turn'],
      ['delivered', 'turn'],
    ])
  })

  it.each([2500, 9000])('takes a %i-character message whole as a turn', async (length) => {
    const body = 'd'.repeat(length)
    await send(body)
    const taken = take()
    expect(taken.text).toContain(`>\n${body}\n</message>`)
    expect(ack(taken.lease)).toBe(1)
    expect((await sent())[0]).toMatchObject({ state: 'delivered', via: 'turn' })
  })

  it('answers nothing for an empty inbox, and counts taking as the mailer being there', () => {
    expect(take()).toEqual({})
    expect(mailers.state(receiver.externalId)).toEqual({ draft: false })
  })

  it('does not take while the agent works or waits, so a lease never sits through a turn', async () => {
    await send('wait for me')
    busyPanes.add(receiver.paneId)
    expect(take()).toEqual({ busy: true })
    expect((await sent())[0]?.state).toBe('queued')
    busyPanes.clear()
    expect(take().text).toContain('wait for me')
  })

  it('stops after the maximum turns in a window and says so', async () => {
    for (let i = 0; i < MAIL_TURNS_MAX; i++) {
      await send(`m${i}`)
      expect(take().lease).toBeTruthy()
    }
    await send('one too many')
    expect(take()).toMatchObject({ limited: true })
    expect((take() as { retryMs?: number }).retryMs).toBeGreaterThan(0)
    expect((await sent()).at(-1)?.state).toBe('queued')
  })

  it('takes events at most once per window and always takes messages', async () => {
    postEvent(sender.externalId, receiver.externalId, 'w-1  done 1s')
    const first = take()
    expect(first.text).toContain('w-1  done 1s')
    postEvent(sender.externalId, receiver.externalId, 'w-1  error 2s')
    await send('a real message')
    const second = take()
    expect(second.text).toContain('a real message')
    expect(second.text).not.toContain('error 2s')
    expect(second.retryMs).toBeGreaterThan(0)
    expect(second.retryMs).toBeLessThanOrEqual(EVENT_BATCH_MS)
    expect(take()).toEqual({ retryMs: expect.any(Number) })
  })

  it('refuses an acknowledgement of a lease another pane was given', async () => {
    await send('mine')
    const taken = take()
    expect(ack(taken.lease, sender)).toBe(0)
    expect(ack(taken.lease)).toBe(1)
  })

  it('records the mailer’s state, draft or gone, from mod-ready', () => {
    call('bus.modReady', receiver, { state: 'draft' })
    expect(mailers.state(receiver.externalId)).toEqual({ draft: true })
    call('bus.modReady', receiver, { state: 'idle' })
    expect(mailers.state(receiver.externalId)).toEqual({ draft: false })
    call('bus.modReady', receiver, { state: 'gone' })
    expect(mailers.state(receiver.externalId)).toBeUndefined()
  })
})

describe('messages Ostia sends on the human’s action', () => {
  it('reach the inbox without hook context, a sent record or an event', () => {
    postBusMessage(sender.externalId, receiver.externalId, '{"kind":"capture"}')
    expect(announce).not.toHaveBeenCalled()
    expect(context()).toEqual({ text: null })
    expect(observed).not.toHaveBeenCalled()
    expect(inbox().map((m) => m.text)).toEqual(['{"kind":"capture"}'])
  })

  it('still wake a pane blocked in bus wait', async () => {
    const waiting = call<Promise<Waited>>('bus.wait', receiver, { timeoutMs: 5000 })
    postBusMessage(sender.externalId, receiver.externalId, '{"kind":"selection"}')
    expect((await waiting).messages.map((m) => m.text)).toEqual(['{"kind":"selection"}'])
  })
})

describe('ext.busSend', () => {
  const extension = registerScript('ext_bus')
  const extSend = (to: string, text: unknown) =>
    call<Promise<Answer>>('ext.busSend', extension, { to, text })

  it('queues for the receiver with the extension as sender, and says why it waits', async () => {
    pendingByPane.set('bus-receiver', 'hibernated')
    expect(await extSend(receiver.externalId, 'from an extension')).toMatchObject({
      ok: true,
      state: 'queued',
      pending: 'hibernated',
    })
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      extension,
      ['all-workspaces'],
      'ext.busSend',
      `to ${receiver.externalId}`,
    )
    expect(inbox().map((m) => [m.from, m.text])).toEqual([
      [extension.externalId, 'from an extension'],
    ])
  })

  it('refuses the manager pane, an empty text and a full inbox', async () => {
    const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'bus-manager-3' })
    markManager('bus-manager-3')
    expect(await extSend(manager.externalId, 'x')).toMatchObject({ error: 'unknown-pane' })
    expect(await extSend(receiver.externalId, '')).toMatchObject({ error: 'invalid-params' })
    for (let i = 0; i < INBOX_MAX; i++)
      postBusMessage(sender.externalId, receiver.externalId, `${i}`)
    expect(await extSend(receiver.externalId, 'x')).toMatchObject({ error: 'inbox-full' })
  })
})

describe('handoffs', () => {
  it('announces a queued handoff by its task and summary and answers its receipt', async () => {
    const res = await call<Promise<Answer>>('bus.handoff', sender, {
      to: receiver.externalId,
      task: 'fix the flaky test',
      summary: 'it fails one run in five',
    })
    expect(res).toMatchObject({ ok: true, state: 'queued' })
    expect(announce).toHaveBeenCalledWith(
      sender,
      receiver,
      'fix the flaky test — it fails one run in five',
    )
    const listed = await call<Promise<{ handoffs: { id: string; state: string }[] }>>(
      'bus.handoffs',
      receiver,
      {},
    )
    const [handoff] = listed.handoffs
    expect(handoff).toMatchObject({ id: res.id, state: 'submitted' })
  })

  it('asks for a summary before it records anything', async () => {
    const res = await call<Promise<Answer>>('bus.handoff', sender, {
      to: receiver.externalId,
      task: 't',
      summary: ' ',
    })
    expect(res).toMatchObject({ ok: false, error: 'summary-required' })
    expect(inbox()).toEqual([])
  })
})

describe('bus observation', () => {
  it('reports who, to whom, which kind and which phase, and never the text', async () => {
    const res = await send('rotate the api key sk-secret')
    expect(observed).toHaveBeenCalledTimes(1)
    expect(observed).toHaveBeenCalledWith({
      id: res.id,
      from: sender.externalId,
      to: receiver.externalId,
      kind: 'message',
      phase: 'queued',
    })
    expect(JSON.stringify(observed.mock.calls)).not.toContain('sk-secret')
  })

  it('reports delivered once when the receiver takes its inbox, and failed when its pane closes', async () => {
    const taken = await send('take me')
    const lost = await send('lose me')
    observed.mockClear()
    inbox(receiver, true)
    inbox(receiver, true)
    expect(observed.mock.calls.map(([o]) => [o.id, o.phase])).toEqual([
      [taken.id, 'delivered'],
      [lost.id, 'delivered'],
    ])
    const closing = await send('too late')
    observed.mockClear()
    failPaneMail(receiver.externalId)
    expect(observed.mock.calls.map(([o]) => [o.id, o.phase])).toEqual([[closing.id, 'failed']])
  })

  it('reports a message handed to a waiting pane as queued, then delivered', async () => {
    const waiting = call<Promise<Waited>>('bus.wait', receiver, { timeoutMs: 5000 })
    await send('wake up')
    ack((await waiting).lease)
    expect(observed.mock.calls.map(([o]) => o.phase)).toEqual(['queued', 'delivered'])
  })

  it('reports a handoff as a task', async () => {
    await call<Promise<unknown>>('bus.handoff', sender, {
      to: receiver.externalId,
      task: 'fix it',
      summary: 'now',
    })
    expect(observed.mock.calls[0]?.[0]).toMatchObject({ kind: 'task', phase: 'queued' })
  })
})

describe('bus.update', () => {
  it('refuses a state that is not a handoff state and keeps the handoff as it was', async () => {
    await call<Promise<unknown>>('bus.handoff', sender, {
      to: receiver.externalId,
      task: 't',
      summary: 's',
    })
    const listed = () =>
      call<Promise<{ handoffs: { id: string; state: string }[] }>>('bus.handoffs', receiver)
    const id = (await listed()).handoffs[0].id
    expect(call('bus.update', receiver, { id, state: 'exploded' })).toMatchObject({
      ok: false,
      error: 'bad-state',
    })
    expect(call('bus.update', receiver, { id, state: undefined })).toMatchObject({ ok: false })
    expect(call('bus.update', receiver, { id, state: 'claimed' })).toEqual({ ok: true })
    expect((await listed()).handoffs[0].state).toBe('claimed')
  })
})

describe('who may wake a hibernated pane by mail', () => {
  it('marks the mail as waking only when the sender holds the type-other-pane reach', async () => {
    await send('no reach')
    held.add('type-other-pane')
    await send('with reach')
    expect(queuedWakes).toEqual([undefined, true])
  })

  it('needs all-workspaces as well for a pane outside the sender’s scope', async () => {
    held.add('type-other-pane')
    await send('far', faraway.externalId)
    held.add('all-workspaces')
    await send('far again', faraway.externalId)
    expect(queuedWakes).toEqual([undefined, true])
  })
})
