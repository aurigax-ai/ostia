import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLATFORM_EVENT_TYPES,
  emitPlatformEvent,
  offPlatformEvent,
  onPlatformEvent,
  platformEvents,
} from './events'

/**
 * `events.ts` is the decoupling point between emitters (`notify.ts`, `index.ts`) and the
 * gateway's `broadcastEvent` — these tests only cover the bus itself (subscribe/emit/unsubscribe
 * plumbing), not any particular emitter or the gateway's cap-gating (covered elsewhere).
 */
describe('platformEvents bus', () => {
  afterEach(() => {
    platformEvents.removeAllListeners()
  })

  it('delivers an emitted payload to a subscriber of the same type', () => {
    const listener = vi.fn()
    onPlatformEvent('notify', listener)

    emitPlatformEvent('notify', { title: 'hi', body: 'there', from: 'pane-1' })

    expect(listener).toHaveBeenCalledWith({ title: 'hi', body: 'there', from: 'pane-1' })
  })

  it('never cross-delivers to a listener subscribed to a different type', () => {
    const notifyListener = vi.fn()
    const doneListener = vi.fn()
    onPlatformEvent('notify', notifyListener)
    onPlatformEvent('agent.done', doneListener)

    emitPlatformEvent('notify', { title: 'hi', from: 'pane-1' })

    expect(notifyListener).toHaveBeenCalledTimes(1)
    expect(doneListener).not.toHaveBeenCalled()
  })

  it('is a no-op when nothing is subscribed (the gateway being off must never throw)', () => {
    expect(() =>
      emitPlatformEvent('session.state', { sessionId: 's1', state: 'idle' }),
    ).not.toThrow()
  })

  it('stops delivering once unsubscribed via offPlatformEvent', () => {
    const listener = vi.fn()
    onPlatformEvent('agent.needs-input', listener)
    offPlatformEvent('agent.needs-input', listener)

    emitPlatformEvent('agent.needs-input', { sessionId: 's1' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('PLATFORM_EVENT_TYPES lists exactly the 5 event types this bus carries', () => {
    expect([...PLATFORM_EVENT_TYPES].sort()).toEqual(
      ['notify', 'agent.needs-input', 'agent.done', 'session.state', 'pane.state'].sort(),
    )
  })
})
