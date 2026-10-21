import { describe, expect, it, vi } from 'vitest'
import { ServerError } from '../../server/serverClient'
import { collectAfterPush } from './syncGc'
import type { RemoteContext } from './syncRemote'

function context(opts: { bound?: boolean; due?: boolean; fails?: ServerError } = {}) {
  const gc = vi.fn(async (..._args: unknown[]) => {
    if (opts.fails) throw opts.fails
    return { deleted: 1 }
  })
  const info = vi.fn(async () => (opts.bound ? { syncGcBound: true } : {}))
  const authed = vi.fn(
    async (
      work: (token: string, routes: { info: typeof info; gc: typeof gc }) => Promise<unknown>,
    ) => work('token', { info, gc }),
  )
  const keyring = { gcDue: vi.fn(() => opts.due ?? true), gcDone: vi.fn() }
  return { ctx: { account: { authed }, keyring } as unknown as RemoteContext, gc, keyring }
}

describe('automatic server clean-up', () => {
  it('SYA-C140 does nothing when it ran within the day', async () => {
    const { ctx, gc, keyring } = context({ bound: true, due: false })
    await collectAfterPush(ctx, ['a'], 3)
    expect(gc).not.toHaveBeenCalled()
    expect(keyring.gcDone).not.toHaveBeenCalled()
  })

  it('SYA-C141 sends the blobs and the version of the manifest it pushed to a server that binds clean-up to it', async () => {
    const { ctx, gc, keyring } = context({ bound: true })
    await collectAfterPush(ctx, ['a', 'b'], 7)
    expect(gc).toHaveBeenCalledWith('token', ['a', 'b'], 7)
    expect(keyring.gcDone).toHaveBeenCalledTimes(1)
  })

  it('SYA-C142 never calls the unbound route on a server that does not advertise the bound one', async () => {
    const { ctx, gc, keyring } = context({ bound: false })
    await collectAfterPush(ctx, ['a'], 7)
    expect(gc).not.toHaveBeenCalled()
    expect(keyring.gcDone).toHaveBeenCalledTimes(1)
  })

  it.each([
    [429, 'rate-limited'],
    [403, 'elevation-required'],
    [412, 'version-mismatch'],
  ])(
    'SYA-C143 counts a %s answer as the day’s attempt and does not ask again',
    async (status, error) => {
      const { ctx, gc, keyring } = context({ bound: true, fails: new ServerError(status, error) })
      await expect(collectAfterPush(ctx, ['a'], 7)).resolves.toBeUndefined()
      expect(gc).toHaveBeenCalledTimes(1)
      expect(keyring.gcDone).toHaveBeenCalledTimes(1)
    },
  )
})
