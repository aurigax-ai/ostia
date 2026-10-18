import { describe, expect, it } from 'vitest'
import {
  EVENT_BATCH_MS,
  MAIL_TURNS_MAX,
  MAIL_TURNS_WINDOW_MS,
} from '../../shared/agents/mailDelivery'
import { Mailers } from './mailers'

function mailers() {
  const clock = { now: 1_000_000 }
  return { m: new Mailers(() => clock.now), clock }
}

describe('Mailers', () => {
  it('knows a pane has a live mailer and whether the human is drafting, until it is cleared', () => {
    const { m } = mailers()
    expect(m.state('p')).toBeUndefined()
    m.set('p', false)
    expect(m.state('p')).toEqual({ draft: false })
    m.set('p', true)
    expect(m.state('p')).toEqual({ draft: true })
    m.clear('p')
    expect(m.state('p')).toBeUndefined()
  })

  it('limits mail turns to the maximum per window and frees them as the window moves', () => {
    const { m, clock } = mailers()
    for (let i = 0; i < MAIL_TURNS_MAX; i++) {
      expect(m.limited('p')).toBe(false)
      m.recordTurn('p')
      clock.now += 1000
    }
    expect(m.limited('p')).toBe(true)
    expect(m.limited('other')).toBe(false)
    clock.now += MAIL_TURNS_WINDOW_MS
    expect(m.limited('p')).toBe(false)
  })

  it('holds events for the batch window after they were taken, and not before', () => {
    const { m, clock } = mailers()
    expect(m.eventsWaitMs('p')).toBe(0)
    m.markEvents('p')
    clock.now += 10_000
    expect(m.eventsWaitMs('p')).toBe(EVENT_BATCH_MS - 10_000)
    clock.now += EVENT_BATCH_MS
    expect(m.eventsWaitMs('p')).toBe(0)
  })

  it('forgets a pane’s turns and batch clock with it', () => {
    const { m } = mailers()
    for (let i = 0; i < MAIL_TURNS_MAX; i++) m.recordTurn('p')
    m.markEvents('p')
    m.clear('p')
    expect(m.limited('p')).toBe(false)
    expect(m.eventsWaitMs('p')).toBe(0)
  })
})
