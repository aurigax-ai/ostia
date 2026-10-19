import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ScreenRequested, ScreenRequests } from './screenRequests'

describe('ScreenRequests', () => {
  let devices: string[]
  let sent: Array<[ScreenRequested, string[]]>
  let requests: ScreenRequests

  beforeEach(() => {
    vi.useFakeTimers()
    devices = ['phone', 'tablet']
    sent = []
    requests = new ScreenRequests(
      () => devices,
      (request, ids) => sent.push([request, ids]),
      () => Date.now(),
      { waitMs: 120_000, cooldownMs: 60_000 },
    )
  })

  afterEach(() => vi.useRealTimers())

  const ask = (sessionId = 'w1') =>
    requests.askFromAgent({ sessionId, reason: 'check the login', pane: 'p1' })

  it('PHA-C10 answers no-phone when no phone can be asked, and asks only phones without a waiting request', async () => {
    devices = []
    expect(ask()).toEqual({ ok: false, error: 'no-phone' })
    devices = ['phone']
    const first = ask('w1')
    expect(first.ok).toBe(true)
    expect(ask('w2')).toEqual({ ok: false, error: 'busy' })
    devices = ['phone', 'tablet']
    const second = ask('w2')
    expect(second.ok).toBe(true)
    expect(sent.map(([request, ids]) => [request.sessionId, ids])).toEqual([
      ['w1', ['phone']],
      ['w2', ['tablet']],
    ])
  })

  it('PHA-C11 starts on the first matching phone, declines only when all asked phones did, then cools down for a minute', async () => {
    const asked = ask()
    if (!asked.ok) throw new Error('not asked')
    const [[request]] = sent
    const id = request.requestId ?? ''
    expect(requests.decline(id, 'stranger', 'off')).toBe(false)
    expect(requests.decline(id, 'phone', 'off')).toBe(true)
    requests.started(id, 'tablet', 'w2')
    expect(requests.decline(id, 'tablet', 'unsupported')).toBe(true)
    expect(await asked.answer).toEqual({ outcome: 'declined', reason: 'off' })
    expect(ask()).toEqual({ ok: false, error: 'cooldown' })
    await vi.advanceTimersByTimeAsync(60_000)
    const again = ask()
    if (!again.ok) throw new Error('not asked again')
    requests.started(sent[1][0].requestId ?? '', 'tablet', 'w1')
    expect(await again.answer).toEqual({ outcome: 'started' })
  })

  it('PHA-C12 answers no-answer after two minutes', async () => {
    const asked = ask()
    if (!asked.ok) throw new Error('not asked')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await asked.answer).toEqual({ outcome: 'no-answer' })
  })
})
