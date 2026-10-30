import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-remote-mail-'))
process.env.XDG_DATA_HOME = dataHome

const { enqueue, flushBus, setBusPath, getMail, inboxOf, queuedOnRoute, resetBus, MAIL_TTL_MS } =
  await import('./busStore')
const { registerPane } = await import('../control/idRegistry')
const { handleRemoteMail } = await import('./remoteMail')

const pending = async () => 'idle-no-wake' as const
let host = ''
let ref = ''
let route = ''
let local: string
let runs = 0

beforeEach(async () => {
  await resetBus()
  runs += 1
  setBusPath(join(dataHome, `bus-${runs}.json`))
  host = `box${runs}`
  ref = `remote:${host}:0123abcd`
  route = `remote:${host}`
  local = registerPane({ windowId: 'w', workspaceId: 'ws', paneId: 'pane-local' }).externalId
})

afterAll(() => rmSync(dataHome, { recursive: true, force: true }))

const inbound = (over: Record<string, unknown> = {}) =>
  handleRemoteMail(
    {
      op: 'in',
      host,
      mail: { pane: '0123abcd', id: 'm1', to: local, text: 'hello', ...over },
    },
    pending,
  )

describe('remote mail, desktop side', () => {
  it('REM-M1 stores incoming mail once, by the sender id, and answers stored on a repeat', async () => {
    enqueue({ from: local, to: ref, text: 'first', route })
    expect(await inbound()).toEqual({ ok: true })
    expect(await inbound()).toEqual({ ok: true })
    const mine = inboxOf(local)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ from: ref, text: 'hello', state: 'queued' })
    expect(mine[0].wakes).toBeUndefined()
  })

  it('REM-M2 refuses mail from a pane the local pane never mailed (reply access only)', async () => {
    expect(await inbound()).toMatchObject({ ok: false, error: 'not-allowed' })
    expect(inboxOf(local)).toHaveLength(0)
  })

  it('REM-M3 refuses a forged sender, an unknown local pane and a bad id', async () => {
    enqueue({ from: local, to: ref, text: 'first', route })
    expect(await inbound({ pane: 'not-a-pane' })).toMatchObject({ error: 'bad-from' })
    expect(await inbound({ pane: '../../etc' })).toMatchObject({ error: 'bad-from' })
    expect(await inbound({ to: 'pane-nobody' })).toMatchObject({ error: 'unknown-pane' })
    expect(await inbound({ id: '' })).toMatchObject({ error: 'bad-id' })
    expect(await inbound({ text: '' })).toMatchObject({ error: 'bad-text' })
    expect(
      await handleRemoteMail(
        { op: 'in', host: 'a:b', mail: { pane: '0123abcd', id: 'x', to: local, text: 't' } },
        pending,
      ),
    ).toMatchObject({ error: 'bad-host' })
    expect(inboxOf(local)).toHaveLength(0)
  })

  it('REM-M4 the same wire id from another host does not collide with a stored one', async () => {
    enqueue({ from: local, to: ref, text: 'first', route })
    enqueue({ from: local, to: 'remote:other:0123abcd', text: 'second', route: 'remote:other' })
    await inbound()
    await handleRemoteMail(
      {
        op: 'in',
        host: 'other',
        mail: { pane: '0123abcd', id: 'm1', to: local, text: 'from other' },
      },
      pending,
    )
    expect(inboxOf(local).map((mail) => mail.text)).toEqual(['hello', 'from other'])
  })

  it('REM-M5 keeps outgoing mail queued until stored, then marks it delivered once', async () => {
    const mail = enqueue({ from: local, to: ref, text: 'out', route })
    const listed = await handleRemoteMail({ op: 'out', host }, pending)
    expect(listed).toMatchObject({ ok: true, out: [{ id: mail.id, from: local, text: 'out' }] })
    expect(queuedOnRoute(route)).toHaveLength(1)
    await handleRemoteMail({ op: 'stored', host, id: mail.id }, pending)
    await handleRemoteMail({ op: 'stored', host, id: mail.id }, pending)
    expect(queuedOnRoute(route)).toHaveLength(0)
    expect(getMail(mail.id)).toMatchObject({ state: 'delivered', via: 'remote' })
    expect(await handleRemoteMail({ op: 'stored', host, id: 'nope' }, pending)).toMatchObject({
      ok: false,
    })
  })

  it('REM-M6 fails outgoing mail the host refused, with the reason', async () => {
    const mail = enqueue({ from: local, to: ref, text: 'out', route })
    await handleRemoteMail({ op: 'refused', host, id: mail.id, reason: 'unknown-pane' }, pending)
    expect(getMail(mail.id)).toMatchObject({ state: 'failed', reason: 'unknown-pane' })
  })

  it('REM-M7 posts one offline notice per outage and one back notice with the counts', async () => {
    enqueue({ from: local, to: ref, text: 'first', route })
    await handleRemoteMail({ op: 'link', host, online: true, delivered: 0 }, pending)
    await handleRemoteMail({ op: 'link', host, online: false }, pending)
    await handleRemoteMail({ op: 'link', host, online: false }, pending)
    const offline = inboxOf(local).filter((mail) => mail.kind === 'event')
    expect(offline).toHaveLength(1)
    expect(offline[0].text).toMatch(
      new RegExp(`${host} is offline since \\d\\d:\\d\\d; 1 message wait`),
    )
    await handleRemoteMail({ op: 'link', host, online: true, delivered: 3 }, pending)
    await handleRemoteMail({ op: 'link', host, online: true, delivered: 3 }, pending)
    await flushBus()
    const lines = inboxOf(local)
      .filter((mail) => mail.kind === 'event')
      .flatMap((mail) => (mail.text ?? '').split('\n'))
    expect(lines.filter((line) => line.includes(' is back;'))).toEqual([
      `${host} is back; 3 messages delivered, 0 expired.`,
    ])
  })

  it('REM-M8 counts mail that expired during the outage', async () => {
    const mail = enqueue({ from: local, to: ref, text: 'old', route })
    await handleRemoteMail({ op: 'link', host, online: true }, pending)
    await handleRemoteMail({ op: 'link', host, online: false }, pending)
    const { sweepBus } = await import('./busStore')
    sweepBus(Date.parse(mail.ts) + MAIL_TTL_MS + 1000)
    const back = await handleRemoteMail({ op: 'link', host, online: true, delivered: 0 }, pending)
    expect(back).toMatchObject({ ok: true, expired: 1 })
  })

  it('REM-M9 does not replay mail whose sender pane has closed, and fails it', async () => {
    const gone = enqueue({ from: 'pane-closed', to: ref, text: 'orphan', route })
    const listed = await handleRemoteMail({ op: 'out', host }, pending)
    expect(listed).toMatchObject({ ok: true, out: [] })
    expect(getMail(gone.id)).toMatchObject({ state: 'failed', reason: 'sender-closed' })
  })
})
