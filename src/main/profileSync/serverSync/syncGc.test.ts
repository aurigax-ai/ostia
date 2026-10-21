import { describe, expect, it, vi } from 'vitest'
import { ServerError } from '../../server/serverClient'
import { collectAfterPush } from './syncGc'
import type { RemoteContext } from './syncRemote'

function context(outcome: 'ok' | ServerError, due = true) {
  const gc = vi.fn(async () => ({ deleted: 1 }))
  const authed = vi.fn(
    async (work: (token: string, routes: { gc: typeof gc }) => Promise<unknown>) => {
      if (outcome !== 'ok') throw outcome
      return work('token', { gc })
    },
  )
  const keyring = { gcDue: vi.fn(() => due), gcDone: vi.fn() }
  return {
    ctx: { account: { authed }, keyring } as unknown as RemoteContext,
    authed,
    gc,
    keyring,
  }
}

describe('automatic server clean-up', () => {
  it('SYA-C140 does nothing when it ran within the day', async () => {
    const { ctx, authed, keyring } = context('ok', false)
    await collectAfterPush(ctx, ['a'])
    expect(authed).not.toHaveBeenCalled()
    expect(keyring.gcDone).not.toHaveBeenCalled()
  })

  it('SYA-C141 keeps the blobs the pushed manifest lists and records the run', async () => {
    const { ctx, gc, keyring } = context('ok')
    await collectAfterPush(ctx, ['a', 'b'])
    expect(gc).toHaveBeenCalledWith('token', ['a', 'b'])
    expect(keyring.gcDone).toHaveBeenCalledTimes(1)
  })

  it('SYA-C142 asks once on a rate limit and waits for the next day', async () => {
    const { ctx, authed, keyring } = context(new ServerError(429, 'rate-limited'))
    await collectAfterPush(ctx, ['a'])
    expect(authed).toHaveBeenCalledTimes(1)
    expect(keyring.gcDone).toHaveBeenCalledTimes(1)
  })

  it('SYA-C143 stays quiet when the session is not elevated and tries again after the next push', async () => {
    const { ctx, keyring } = context(new ServerError(403, 'elevation-required'))
    await expect(collectAfterPush(ctx, ['a'])).resolves.toBeUndefined()
    expect(keyring.gcDone).not.toHaveBeenCalled()
  })
})
