import { mkdtempSync, rmSync, statSync } from 'node:fs'
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
  mailViews,
  resetBus,
  sentBy,
  setBusJournal,
  setBusObserver,
  setPending,
  takeMail,
  whenSettled,
} = store

const observed = vi.fn()
const mailJournal = { mail: vi.fn(), leaseTimeout: vi.fn() }
const all = () => true

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

    const first = takeMail('b', 'read', all)
    expect(first.map((m) => m.text)).toEqual(['build is green'])
    expect(takeMail('b', 'read', all)).toEqual([])

    const after = getMail(mail.id)
    expect(after).toMatchObject({ state: 'delivered', via: 'read', preview: 'build is green' })
    expect(after?.text).toBeUndefined()
    expect(inboxOf('b')).toEqual([])
  })

  it('hands each message to exactly one of two takes in a row', () => {
    for (let i = 0; i < 5; i++) send(`m${i}`)
    const one = takeMail('b', 'prompt', all)
    const two = takeMail('b', 'read', all)
    expect(one).toHaveLength(5)
    expect(two).toEqual([])
    expect(new Set(one.map((m) => m.id)).size).toBe(5)
  })

  it('takes only what the picker allows and only for that receiver', () => {
    const keep = send('keep')
    send('other pane', 'c')
    const taken = takeMail('b', 'read', (m) => m.id !== keep.id)
    expect(taken).toEqual([])
    expect(getMail(keep.id)?.state).toBe('queued')
    expect(inboxOf('c')).toHaveLength(1)
  })

  it('keeps the order messages were sent in', () => {
    send('one')
    send('two')
    send('three')
    expect(takeMail('b', 'read', all).map((m) => m.text)).toEqual(['one', 'two', 'three'])
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
    expect(takeMail('b', 'read', all)).toEqual([])
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
    expect(takeMail('b', 'read', all).map((m) => m.id)).toEqual([mail.id])
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
    expect(takeMail('b', 'read', all)).toEqual([])
  })

  it('names an expiry without a known reason as queued', () => {
    const mail = send()
    vi.setSystemTime(Date.now() + MAIL_TTL_MS + 1)
    expect(getMail(mail.id)?.reason).toBe('expired:queued')
  })

  it('does not expire mail that was delivered', () => {
    const mail = send()
    takeMail('b', 'read', all)
    vi.setSystemTime(Date.now() + MAIL_TTL_MS + 1)
    expect(getMail(mail.id)?.state).toBe('delivered')
  })

  it('fails queued and leased mail for a closed pane at once, and leaves others alone', () => {
    const queued = send('one')
    const leasedOne = send('two')
    leaseMail('b', 'prompt', (m) => m.id === leasedOne.id)
    const delivered = send('three')
    takeMail('b', 'read', (m) => m.id === delivered.id)
    const other = send('four', 'c')

    failPaneMail('b')

    expect(getMail(queued.id)).toMatchObject({ state: 'failed', reason: 'pane-closed' })
    expect(getMail(leasedOne.id)).toMatchObject({ state: 'failed', reason: 'pane-closed' })
    expect(getMail(delivered.id)?.state).toBe('delivered')
    expect(getMail(other.id)?.state).toBe('queued')
  })

  it('drops history after seven days and past 500 per sender', () => {
    const old = send('old')
    takeMail('b', 'read', all)
    vi.setSystemTime(Date.now() + HISTORY_MS + 1000)
    send('fresh', 'b', 'z')
    expect(getMail(old.id)).toBeUndefined()

    const first = enqueue({ from: 'busy', to: 'd', text: 'm0' })
    takeMail('d', 'read', all)
    for (let i = 1; i <= HISTORY_PER_SENDER; i++) {
      enqueue({ from: 'busy', to: 'd', text: `m${i}` })
      takeMail('d', 'read', all)
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
    takeMail('b', 'read', (m) => m.id === read.id)
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
    takeMail('b', 'read', all)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    send('three')
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
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
    takeMail('b', 'read', (m) => m.text === 'm0')
    expect(inboxFull('b')).toBe(false)
  })
})

describe('observation', () => {
  it('reports queued, then delivered or failed, once each and never for a quiet message', () => {
    const a = send('x')
    const b = send('y')
    enqueue({ from: 'a', to: 'b', text: 'q', quiet: true })
    takeMail('b', 'read', (m) => m.id === a.id)
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
  it('delivers mail straight to a parked waiter as read', () => {
    const got = vi.fn()
    addWaiter('b', got)
    const mail = send('wake up')
    expect(got).toHaveBeenCalledOnce()
    expect(got.mock.calls[0][0].map((m: { text: string }) => m.text)).toEqual(['wake up'])
    expect(getMail(mail.id)).toMatchObject({ state: 'delivered', via: 'read' })
  })

  it('queues again once a waiter is unregistered', () => {
    const got = vi.fn()
    const off = addWaiter('b', got)
    off()
    expect(send('anyone?').state).toBe('queued')
    expect(got).not.toHaveBeenCalled()
  })

  it('resolves a send that waits when the mail is delivered, failed or the time runs out', async () => {
    const abort = new AbortController()
    const delivered = send('one')
    const pending = whenSettled(delivered.id, 5000, abort.signal)
    takeMail('b', 'prompt', all)
    expect(await pending).toMatchObject({ state: 'delivered', via: 'prompt' })

    const closing = send('two')
    const failing = whenSettled(closing.id, 5000, abort.signal)
    failPaneMail('b')
    expect(await failing).toMatchObject({ state: 'failed', reason: 'pane-closed' })

    const slow = send('three', 'c')
    const timed = whenSettled(slow.id, 3000, abort.signal)
    vi.advanceTimersByTime(3000)
    expect(await timed).toMatchObject({ state: 'queued' })
  })

  it('resolves at once for mail that is already settled, and for an unknown id', async () => {
    const abort = new AbortController()
    const mail = send()
    takeMail('b', 'read', all)
    expect(await whenSettled(mail.id, 5000, abort.signal)).toMatchObject({ state: 'delivered' })
    expect(await whenSettled('missing', 5000, abort.signal)).toBeUndefined()
  })

  it('stops waiting when the caller goes away', async () => {
    const abort = new AbortController()
    const mail = send()
    const pending = whenSettled(mail.id, 60_000, abort.signal)
    abort.abort()
    expect(await pending).toMatchObject({ state: 'queued' })
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
    takeMail('b', 'read', all)
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
