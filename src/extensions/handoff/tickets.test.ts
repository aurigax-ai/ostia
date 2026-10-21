import { describe, expect, it } from 'vitest'
import { TICKET_TTL_MS, TICKETS_MAX, Tickets } from './tickets'

const TOPIC = {
  topic: 'checkout retries',
  agent: 'claude',
  sessionId: 's-1',
  cwd: '/w',
  workDir: '/w',
  workspaceId: 'w1',
}

function setup(waitMs = 20) {
  const clock = { now: 1_000 }
  let next = 0
  const tickets = new Tickets({ now: () => clock.now, newId: () => `t${++next}`, waitMs })
  return { clock, tickets }
}

describe('handoff tickets', () => {
  it('is claimed once, by the pane it opened', async () => {
    const { tickets } = setup()
    const ticket = tickets.create(TOPIC)
    tickets.opened(ticket.id, 'p2')
    const first = await tickets.claim(ticket.id, 'p2')
    expect(first).toMatchObject({
      ok: true,
      ticket: { topic: 'checkout retries', claimedBy: 'p2' },
    })
    expect(await tickets.claim(ticket.id, 'p2')).toEqual({ ok: false, error: 'claimed-ticket' })
  })

  it('refuses a pane that did not open it and keeps the ticket for the right one', async () => {
    const { tickets } = setup()
    const ticket = tickets.create(TOPIC)
    tickets.opened(ticket.id, 'p2')
    expect(await tickets.claim(ticket.id, 'p9')).toEqual({ ok: false, error: 'wrong-pane' })
    expect((await tickets.claim(ticket.id, 'p2')).ok).toBe(true)
  })

  it('waits for the open to be reported, then gives up', async () => {
    const { tickets } = setup(15)
    const late = tickets.create(TOPIC)
    const pending = tickets.claim(late.id, 'p2')
    tickets.opened(late.id, 'p2')
    expect((await pending).ok).toBe(true)
    const never = tickets.create(TOPIC)
    expect(await tickets.claim(never.id, 'p2')).toEqual({ ok: false, error: 'wrong-pane' })
  })

  it('expires after ten minutes', async () => {
    const { clock, tickets } = setup()
    const ticket = tickets.create(TOPIC)
    tickets.opened(ticket.id, 'p2')
    clock.now += TICKET_TTL_MS + 1
    expect(await tickets.claim(ticket.id, 'p2')).toEqual({ ok: false, error: 'expired-ticket' })
    expect(await tickets.claim(ticket.id, 'p2')).toEqual({ ok: false, error: 'unknown-ticket' })
  })

  it('forgets a dropped ticket and an unknown id', async () => {
    const { tickets } = setup()
    const ticket = tickets.create(TOPIC)
    tickets.drop(ticket.id)
    expect(await tickets.claim(ticket.id, 'p2')).toEqual({ ok: false, error: 'unknown-ticket' })
    expect(await tickets.claim('nope', 'p2')).toEqual({ ok: false, error: 'unknown-ticket' })
  })

  it('remembers which ticket a pane claimed until the pane closes', async () => {
    const { tickets } = setup()
    const ticket = tickets.create(TOPIC)
    tickets.opened(ticket.id, 'p2')
    await tickets.claim(ticket.id, 'p2')
    expect(tickets.claimedBy('p2')?.sessionId).toBe('s-1')
    tickets.forget('p2')
    expect(tickets.claimedBy('p2')).toBeNull()
  })

  it('keeps at most a few open tickets', async () => {
    const { tickets } = setup()
    const first = tickets.create(TOPIC)
    for (let i = 0; i < TICKETS_MAX; i++) tickets.create(TOPIC)
    expect(await tickets.claim(first.id, 'p2')).toEqual({ ok: false, error: 'unknown-ticket' })
  })
})
