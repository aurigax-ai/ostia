import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-busstore-'))
process.env.XDG_DATA_HOME = dataHome

const store = await import('./busStore')
const {
  HISTORY_MS,
  HISTORY_PER_SENDER,
  INBOX_MAX,
  LEASE_MS,
  MAIL_TTL_MS,
  ackMail,
  dismissFailed,
  addWaiter,
  enqueue,
  failPaneMail,
  flushBus,
  getMail,
  inboxFull,
  onBusChange,
  inboxOf,
  leaseMail,
  releaseMail,
  sentAfter,
  mailCounts,
  mailViews,
  resetBus,
  sentBy,
  dropWatchesOf,
  postEvent,
  setBusJournal,
  unwatchPanes,
  watchPane,
  watchersOf,
  watchesOf,
  setBusObserver,
  setPending,
} = store

const observed = vi.fn()
const mailJournal = { mail: vi.fn(), leaseTimeout: vi.fn() }
const all = () => true

function deliver(...args: Parameters<typeof leaseMail>) {
  const handed = leaseMail(...args)
  if (handed) ackMail(args[0], handed.lease)
  return handed?.messages ?? []
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-10-18T10:00:00Z'))
  await resetBus()
  rmSync(join(dataHome, 'ostia'), { recursive: true, force: true })
  observed.mockClear()
  mailJournal.mail.mockClear()
  mailJournal.leaseTimeout.mockClear()
  setBusObserver(observed)
  setBusJournal(mailJournal)
})

afterEach(async () => {
  vi.useRealTimers()
  await flushBus()
})

afterAll(() => rmSync(dataHome, { recursive: true, force: true }))

const send = (text = 'hi', to = 'b', from = 'a') => enqueue({ from, to, text })

describe('mail states', () => {
  it('starts queued, is delivered once by take, and drops its text after', () => {
    const mail = send('build is green')
    expect(getMail(mail.id)).toMatchObject({ state: 'queued', text: 'build is green' })

    const first = deliver('b', 'read', all)
    expect(first.map((m) => m.text)).toEqual(['build is green'])
    expect(deliver('b', 'read', all)).toEqual([])

    const after = getMail(mail.id)
    expect(after).toMatchObject({ state: 'delivered', via: 'read', preview: 'build is green' })
    expect(after?.text).toBeUndefined()
    expect(inboxOf('b')).toEqual([])
  })

  it('hands each message to exactly one of two takes in a row', () => {
    for (let i = 0; i < 5; i++) send(`m${i}`)
    const one = deliver('b', 'prompt', all)
    const two = deliver('b', 'read', all)
    expect(one).toHaveLength(5)
    expect(two).toEqual([])
    expect(new Set(one.map((m) => m.id)).size).toBe(5)
  })

  it('takes only what the picker allows and only for that receiver', () => {
    const keep = send('keep')
    send('other pane', 'c')
    const taken = deliver('b', 'read', (m) => m.id !== keep.id)
    expect(taken).toEqual([])
    expect(getMail(keep.id)?.state).toBe('queued')
    expect(inboxOf('c')).toHaveLength(1)
  })

  it('keeps the order messages were sent in', () => {
    send('one')
    send('two')
    send('three')
    expect(deliver('b', 'read', all).map((m) => m.text)).toEqual(['one', 'two', 'three'])
  })

  it('lists a sender only its own non-quiet mail, newest last', () => {
    send('mine')
    send('theirs', 'a', 'b')
    enqueue({ from: 'a', to: 'b', text: 'report', quiet: true })
    expect(sentBy('a').map((m) => m.preview)).toEqual(['mine'])
  })
})

describe('leases', () => {
  it('moves leased mail to delivered on ack, once, only for the receiver', () => {
    const mail = send()
    const lease = leaseMail('b', 'prompt', all)
    expect(lease?.messages.map((m) => m.id)).toEqual([mail.id])
    expect(getMail(mail.id)?.state).toBe('leased')
    expect(deliver('b', 'read', all)).toEqual([])
    expect(inboxOf('b')).toHaveLength(1)

    expect(ackMail('c', lease?.lease ?? '')).toEqual([])
    expect(ackMail('b', 'not-a-lease')).toEqual([])
    expect(ackMail('b', lease?.lease ?? '')).toEqual([mail.id])
    expect(ackMail('b', lease?.lease ?? '')).toEqual([])
    expect(getMail(mail.id)).toMatchObject({ state: 'delivered', via: 'prompt' })
  })

  it('returns an unacknowledged lease to queued after the timeout, so a later take gets it', () => {
    const mail = send()
    const lease = leaseMail('b', 'start', all)
    vi.setSystemTime(Date.now() + LEASE_MS + 1)
    expect(getMail(mail.id)?.state).toBe('queued')
    expect(ackMail('b', lease?.lease ?? '')).toEqual([])
    expect(deliver('b', 'read', all).map((m) => m.id)).toEqual([mail.id])
  })

  it('leases nothing when there is nothing queued', () => {
    expect(leaseMail('b', 'prompt', all)).toBeUndefined()
  })
})

describe('expiry and closing', () => {
  it('fails queued mail after 24 hours with the last pending reason', () => {
    const mail = send()
    setPending(mail.id, 'hibernated')
    vi.setSystemTime(Date.now() + MAIL_TTL_MS - 1000)
    expect(getMail(mail.id)?.state).toBe('queued')
    vi.setSystemTime(Date.now() + 2000)
    expect(getMail(mail.id)).toMatchObject({ state: 'failed', reason: 'expired:hibernated' })
    expect(deliver('b', 'read', all)).toEqual([])
  })

  it('names an expiry without a known reason as queued', () => {
    const mail = send()
    vi.setSystemTime(Date.now() + MAIL_TTL_MS + 1)
    expect(getMail(mail.id)?.reason).toBe('expired:queued')
  })

  it('does not expire mail that was delivered', () => {
    const mail = send()
    deliver('b', 'read', all)
    vi.setSystemTime(Date.now() + MAIL_TTL_MS + 1)
    expect(getMail(mail.id)?.state).toBe('delivered')
  })

  it('fails queued and leased mail for a closed pane at once, and leaves others alone', () => {
    const queued = send('one')
    const leasedOne = send('two')
    leaseMail('b', 'prompt', (m) => m.id === leasedOne.id)
    const delivered = send('three')
    deliver('b', 'read', (m) => m.id === delivered.id)
    const other = send('four', 'c')

    failPaneMail('b')

    expect(getMail(queued.id)).toMatchObject({ state: 'failed', reason: 'pane-closed' })
    expect(getMail(leasedOne.id)).toMatchObject({ state: 'failed', reason: 'pane-closed' })
    expect(getMail(delivered.id)?.state).toBe('delivered')
    expect(getMail(other.id)?.state).toBe('queued')
  })

  it('drops history after seven days and past 500 per sender', () => {
    const old = send('old')
    deliver('b', 'read', all)
    vi.setSystemTime(Date.now() + HISTORY_MS + 1000)
    send('fresh', 'b', 'z')
    expect(getMail(old.id)).toBeUndefined()

    const first = enqueue({ from: 'busy', to: 'd', text: 'm0' })
    deliver('d', 'read', all)
    for (let i = 1; i <= HISTORY_PER_SENDER; i++) {
      enqueue({ from: 'busy', to: 'd', text: `m${i}` })
      deliver('d', 'read', all)
    }
    const last = enqueue({ from: 'busy', to: 'd', text: 'last' })
    expect(getMail(first.id)).toBeUndefined()
    expect(getMail(last.id)).toBeDefined()
  })
})

describe('mail views', () => {
  it('shows undelivered mail as queued, leased mail too, and leaves out delivered and quiet mail', () => {
    const waiting = send('wait')
    const leased = send('leased')
    leaseMail('b', 'prompt', (m) => m.id === leased.id)
    const read = send('read')
    deliver('b', 'read', (m) => m.id === read.id)
    enqueue({ from: 'a', to: 'b', text: 'report', quiet: true })
    setPending(waiting.id, 'hibernated')
    expect(mailViews().map((v) => [v.id, v.state, v.pending])).toEqual([
      [waiting.id, 'queued', 'hibernated'],
      [leased.id, 'queued', undefined],
    ])
  })

  it('shows a failed message with its reason until it is dismissed, at most five per pane', () => {
    for (let i = 0; i < 7; i++) send(`m${i}`)
    failPaneMail('b')
    const shown = mailViews()
    expect(shown).toHaveLength(5)
    expect(shown.every((v) => v.state === 'failed' && v.reason === 'pane-closed')).toBe(true)
    dismissFailed('c')
    expect(mailViews()).toHaveLength(5)
    dismissFailed('b')
    expect(mailViews()).toEqual([])
  })

  it('keeps a dismissal across a reload', async () => {
    send()
    failPaneMail('b')
    dismissFailed('b')
    await flushBus()
    await resetBus()
    expect(mailViews()).toEqual([])
  })

  it('tells a listener once per change, however many mutations the change made', async () => {
    const listener = vi.fn()
    const off = onBusChange(listener)
    send('one')
    send('two')
    deliver('b', 'read', all)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    send('three')
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('events and watches', () => {
  it('keeps one queued event per watched pane and subscriber, with every line since, and starts a new one after a take', () => {
    postEvent('w', 'b', 'first line')
    postEvent('w', 'b', 'second line')
    postEvent('other', 'b', 'from another pane')
    const queued = inboxOf('b')
    expect(queued.map((m) => [m.kind, m.from, m.text])).toEqual([
      ['event', 'w', 'first line\nsecond line'],
      ['event', 'other', 'from another pane'],
    ])
    deliver('b', 'read', all)
    postEvent('w', 'b', 'third line')
    expect(inboxOf('b').map((m) => m.text)).toEqual(['third line'])
  })

  it('keeps only the newest lines of a long run of coalesced events, and shows the newest as the preview', () => {
    for (let i = 1; i <= 30; i++) postEvent('w', 'b', `line ${i}`)
    const [event] = inboxOf('b')
    const lines = (event.text ?? '').split('\n')
    expect(lines).toHaveLength(20)
    expect(lines[0]).toBe('line 11')
    expect(lines.at(-1)).toBe('line 30')
    expect(event.preview).toBe('line 30')
  })

  it('leaves events out of the sender’s list, the sender’s counts and the extension events', () => {
    postEvent('w', 'b', 'status')
    expect(sentBy('w')).toEqual([])
    expect(mailCounts('w')).toMatchObject({ sentQueued: 0, sentFailed: 0 })
    expect(mailCounts('b')).toMatchObject({ queued: 1 })
    expect(observed).not.toHaveBeenCalled()
    expect(mailViews().map((v) => v.state)).toEqual(['queued'])
  })

  it('fails an event with the rest of the pane’s mail, and delivers it to a parked waiter', () => {
    const got = vi.fn()
    addWaiter('b', got)
    postEvent('w', 'b', 'status')
    expect(got.mock.calls[0][0].messages.map((m: { kind: string }) => m.kind)).toEqual(['event'])
    ackMail('b', got.mock.calls[0][0].lease)
    postEvent('w', 'c', 'status')
    failPaneMail('c')
    expect(mailViews().map((v) => v.state)).toEqual(['failed'])
  })

  it('stores a watch once per pair, lists it by subscriber and by watched pane, and ends it on request', () => {
    watchPane('boss', 'w1', ['done'])
    watchPane('boss', 'w1', ['error'])
    watchPane('boss', 'w2', ['done'])
    watchPane('other', 'w1', ['done'])
    expect(watchesOf('boss').map((w) => [w.watched, w.until])).toEqual([
      ['w1', ['error']],
      ['w2', ['done']],
    ])
    expect(watchersOf('w1').map((w) => w.subscriber)).toEqual(['boss', 'other'])
    unwatchPanes('boss', ['w1'])
    expect(watchesOf('boss').map((w) => w.watched)).toEqual(['w2'])
    unwatchPanes('boss')
    expect(watchesOf('boss')).toEqual([])
  })

  it('drops every watch a closed pane took part in, whichever side it was on', () => {
    watchPane('boss', 'w1', ['done'])
    watchPane('w1', 'w2', ['done'])
    watchPane('other', 'w3', ['done'])
    dropWatchesOf('w1')
    expect(watchesOf('boss')).toEqual([])
    expect(watchesOf('w1')).toEqual([])
    expect(watchesOf('other')).toHaveLength(1)
  })

  it('keeps watches across a reload', async () => {
    watchPane('boss', 'w1', ['done', 'command'])
    await flushBus()
    await resetBus()
    expect(watchesOf('boss')).toEqual([
      { subscriber: 'boss', watched: 'w1', until: ['done', 'command'] },
    ])
  })
})

describe('journal', () => {
  it('reports an expiry and a closed pane by reason and age, and never the text or ids', () => {
    const lost = send('secret text')
    setPending(lost.id, 'hibernated')
    vi.setSystemTime(Date.now() + MAIL_TTL_MS + 1000)
    getMail(lost.id)
    send('another secret', 'c')
    vi.setSystemTime(Date.now() + 5000)
    failPaneMail('c')
    expect(mailJournal.mail.mock.calls).toEqual([
      ['expired:hibernated', MAIL_TTL_MS + 1000],
      ['pane-closed', 5000],
    ])
    expect(JSON.stringify(mailJournal.mail.mock.calls)).not.toContain('secret')
  })

  it('reports a lease that timed out, with the age of the message', () => {
    send()
    leaseMail('b', 'prompt', all)
    vi.setSystemTime(Date.now() + LEASE_MS + 1)
    inboxOf('b')
    expect(mailJournal.leaseTimeout).toHaveBeenCalledWith(LEASE_MS + 1)
  })
})

describe('caps', () => {
  it('is full at 200 undelivered messages, and delivering frees room', () => {
    for (let i = 0; i < INBOX_MAX; i++) send(`m${i}`)
    expect(inboxFull('b')).toBe(true)
    expect(inboxFull('c')).toBe(false)
    deliver('b', 'read', (m) => m.text === 'm0')
    expect(inboxFull('b')).toBe(false)
  })
})

describe('observation', () => {
  it('reports queued, then delivered or failed, once each and never for a quiet message', () => {
    const a = send('x')
    const b = send('y')
    enqueue({ from: 'a', to: 'b', text: 'q', quiet: true })
    deliver('b', 'read', (m) => m.id === a.id)
    failPaneMail('b')
    expect(observed.mock.calls.map(([o]) => [o.id, o.phase])).toEqual([
      [a.id, 'queued'],
      [b.id, 'queued'],
      [a.id, 'delivered'],
      [b.id, 'failed'],
    ])
    expect(JSON.stringify(observed.mock.calls)).not.toContain('"x"')
  })
})

describe('waiting', () => {
  it('leases mail straight to a parked waiter and delivers it as read on ack', () => {
    const got = vi.fn()
    addWaiter('b', got)
    const mail = send('wake up')
    expect(got).toHaveBeenCalledOnce()
    const handed = got.mock.calls[0][0]
    expect(handed.messages.map((m: { text: string }) => m.text)).toEqual(['wake up'])
    expect(getMail(mail.id)).toMatchObject({ state: 'leased', via: 'read' })
    ackMail('b', handed.lease)
    expect(getMail(mail.id)).toMatchObject({ state: 'delivered', via: 'read' })
  })

  it('queues mail handed to a waiter again when its lease is released unacknowledged', () => {
    const got = vi.fn()
    addWaiter('b', got)
    const mail = send('do not lose me')
    releaseMail('b', got.mock.calls[0][0].lease)
    expect(getMail(mail.id)).toMatchObject({ state: 'queued' })
  })

  it('hands a message to only the first of two parked waits of one pane, and keeps the other parked', () => {
    const first = vi.fn()
    const second = vi.fn()
    addWaiter('b', first)
    addWaiter('b', second)
    send('only once')
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    const next = send('for the second')
    expect(second).toHaveBeenCalledOnce()
    expect(second.mock.calls[0][0].messages.map((m: { id: string }) => m.id)).toEqual([next.id])
  })

  it('hands a waiter that picks only the messages it picks, and leaves the rest queued', () => {
    const got = vi.fn()
    addWaiter('b', got, (mail) => mail.from === 'c')
    const other = send('from a')
    expect(got).not.toHaveBeenCalled()
    expect(getMail(other.id)).toMatchObject({ state: 'queued' })
    const wanted = send('from c', 'b', 'c')
    expect(got).toHaveBeenCalledOnce()
    expect(got.mock.calls[0][0].messages.map((m: { id: string }) => m.id)).toEqual([wanted.id])
  })

  it('hands a message to the waiter that picks it before a plain waiter parked earlier', () => {
    const plain = vi.fn()
    const picky = vi.fn()
    addWaiter('b', plain)
    addWaiter('b', picky, (mail) => mail.from === 'c')
    send('from c', 'b', 'c')
    expect(picky).toHaveBeenCalledOnce()
    expect(plain).not.toHaveBeenCalled()
    send('from a')
    expect(plain).toHaveBeenCalledOnce()
  })

  it('tells a message sent after another by its place in the store, not its clock', () => {
    const before = send('before')
    const question = send('question')
    const after = send('after')
    const later = sentAfter(question.id, question.ts)
    expect(later(before)).toBe(false)
    expect(later(after)).toBe(true)
    expect(sentAfter('gone', question.ts)(after)).toBe(true)
  })

  it('queues again once a waiter is unregistered', () => {
    const got = vi.fn()
    const off = addWaiter('b', got)
    off()
    expect(send('anyone?').state).toBe('queued')
    expect(got).not.toHaveBeenCalled()
  })
})

describe('persistence', () => {
  const file = () => join(dataHome, 'ostia', 'bus.json')

  it('writes the store 0600 in a 0700 folder, and a reload keeps queued mail', async () => {
    const mail = send('keep me')
    await flushBus()
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataHome, 'ostia')).mode & 0o777).toBe(0o700)

    await resetBus()
    expect(inboxOf('b').map((m) => [m.id, m.text])).toEqual([[mail.id, 'keep me']])
  })

  it('keeps only the preview of delivered mail on disk, not the text', async () => {
    send('first line\nsecond line sk-abc')
    deliver('b', 'read', all)
    await flushBus()
    const { readFileSync } = await import('node:fs')
    const written = readFileSync(file(), 'utf8')
    expect(written).toContain('first line')
    expect(written).not.toContain('sk-abc')
  })

  it('reads a store written by an older version as empty', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dataHome, 'ostia'), { recursive: true })
    writeFileSync(file(), JSON.stringify({ inboxes: { b: [{ id: 'x', text: 'old' }] }, sent: [] }))
    await resetBus()
    expect(inboxOf('b')).toEqual([])
  })
})

describe('receive', () => {
  it('REM-S1 writes the mail to disk before answering stored, and stores nothing when the write fails', async () => {
    const good = join(dataHome, 'receive-good.json')
    store.setBusPath(good)
    const blocker = join(dataHome, 'not-a-folder')
    writeFileSync(blocker, '')
    store.setBusPath(join(blocker, 'bus.json'))
    const draft = {
      id: 'h:1',
      origin: 'remote:h',
      from: 'remote:h:0123abcd',
      to: 'p1',
      text: 'once',
    }
    await expect(store.receive(draft)).rejects.toThrow()
    expect(inboxOf('p1')).toHaveLength(0)
    store.setBusPath(good)
    await expect(store.receive(draft)).resolves.toBe('stored')
    await expect(store.receive(draft)).resolves.toBe('stored')
    expect(inboxOf('p1')).toHaveLength(1)
    expect(
      JSON.parse(readFileSync(good, 'utf8')).mail.map((mail: { id: string }) => mail.id),
    ).toContain('h:1')
  })

  it('REM-S2 dedupes on the origin and the id, so two hosts may send the same id and neither is lost', async () => {
    const base = { id: 'same', from: 'x', to: 'p2', text: 'a' }
    await store.receive({ ...base, origin: 'remote:one' })
    await store.receive({ ...base, origin: 'remote:two', text: 'b' })
    await store.receive({ ...base, origin: 'remote:one' })
    expect(inboxOf('p2').map((mail) => mail.text)).toEqual(['a', 'b'])
  })

  it('REM-S3 answers stored once for the same mail received twice at the same time', async () => {
    const draft = { id: 'dup', origin: 'remote:h', from: 'x', to: 'p3', text: 'once' }
    await Promise.all([store.receive(draft), store.receive(draft)])
    expect(inboxOf('p3')).toHaveLength(1)
  })
})
