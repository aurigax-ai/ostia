import { describe, expect, it } from 'vitest'
import { actThenConfirm, ChangeSignal, confirmed, mismatch } from './actThenConfirm'

describe('actThenConfirm', () => {
  it('acts first, then answers with what it observed at once', async () => {
    const steps: string[] = []
    const seen = await actThenConfirm({
      act: () => steps.push('act'),
      observe: () => {
        steps.push('observe')
        return confirmed('done')
      },
      signal: () => () => {},
      timeoutMs: 1000,
      onTimeout: () => mismatch('late'),
    })
    expect(steps).toEqual(['act', 'observe'])
    expect(seen).toEqual({ ok: true, value: 'done' })
  })

  it('looks again on each signal until the state settles', async () => {
    const signal = new ChangeSignal()
    let state = 'starting'
    const answer = actThenConfirm<string>({
      act: () => undefined,
      observe: () => (state === 'running' ? confirmed(state) : undefined),
      signal: signal.subscribe,
      timeoutMs: 1000,
      onTimeout: () => mismatch('timed out'),
    })
    signal.fire()
    state = 'running'
    signal.fire()
    await expect(answer).resolves.toEqual({ ok: true, value: 'running' })
  })

  it('answers a mismatch with its reason, and the timeout state when nothing settles', async () => {
    await expect(
      actThenConfirm({
        act: () => undefined,
        observe: () => mismatch('gone', { status: 'failed' }),
        signal: () => () => {},
        timeoutMs: 1000,
        onTimeout: () => mismatch('late'),
      }),
    ).resolves.toEqual({ ok: false, reason: 'gone', value: { status: 'failed' } })
    await expect(
      actThenConfirm({
        act: () => undefined,
        observe: () => undefined,
        signal: () => () => {},
        timeoutMs: 5,
        onTimeout: () => mismatch('timed out'),
      }),
    ).resolves.toEqual({ ok: false, reason: 'timed out' })
  })
})
