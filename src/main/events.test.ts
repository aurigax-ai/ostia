import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLATFORM_EVENT_TYPES, emitPlatformEvent, emitSessionState, platformEvents } from './events'

describe('platformEvents bus', () => {
  afterEach(() => {
    platformEvents.removeAllListeners()
  })

  it('delivers an emitted payload to a subscriber of the same type', () => {
    const listener = vi.fn()
    platformEvents.on('notify', listener)

    emitPlatformEvent('notify', { title: 'hi', body: 'there', from: 'pane-1' })

    expect(listener).toHaveBeenCalledWith({ title: 'hi', body: 'there', from: 'pane-1' })
  })

  it('never cross-delivers to a listener subscribed to a different type', () => {
    const notifyListener = vi.fn()
    const doneListener = vi.fn()
    platformEvents.on('notify', notifyListener)
    platformEvents.on('agent.done', doneListener)

    emitPlatformEvent('notify', { title: 'hi', from: 'pane-1' })

    expect(notifyListener).toHaveBeenCalledTimes(1)
    expect(doneListener).not.toHaveBeenCalled()
  })

  it('is a no-op when nothing is subscribed (the gateway being off must never throw)', () => {
    expect(() =>
      emitPlatformEvent('session.state', { sessionId: 's1', state: 'idle' }),
    ).not.toThrow()
  })

  it('stops delivering once unsubscribed via platformEvents.off', () => {
    const listener = vi.fn()
    platformEvents.on('agent.needs-input', listener)
    platformEvents.off('agent.needs-input', listener)

    emitPlatformEvent('agent.needs-input', { sessionId: 's1' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('emitSessionState fans a waiting session out to session.state and agent.needs-input', () => {
    const state = vi.fn()
    const needsInput = vi.fn()
    const done = vi.fn()
    platformEvents.on('session.state', state)
    platformEvents.on('agent.needs-input', needsInput)
    platformEvents.on('agent.done', done)

    emitSessionState('s1', 'waiting')

    expect(state).toHaveBeenCalledWith({ sessionId: 's1', state: 'waiting' })
    expect(needsInput).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(done).not.toHaveBeenCalled()
  })

  it('emitSessionState emits agent.done for done and no agent event for working', () => {
    const needsInput = vi.fn()
    const done = vi.fn()
    platformEvents.on('agent.needs-input', needsInput)
    platformEvents.on('agent.done', done)

    emitSessionState('s1', 'done')
    emitSessionState('s1', 'working')

    expect(done).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(needsInput).not.toHaveBeenCalled()
  })

  it('PLATFORM_EVENT_TYPES lists exactly the 7 event types this bus carries', () => {
    expect([...PLATFORM_EVENT_TYPES].sort()).toEqual(
      [
        'notify',
        'agent.needs-input',
        'agent.done',
        'session.state',
        'pane.state',
        'ask.created',
        'ask.resolved',
      ].sort(),
    )
  })
})
