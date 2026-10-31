import { describe, expect, it, vi } from 'vitest'
import { digestOf } from '../../server/deviceKeys'
import { ServerError } from '../../server/serverClient'
import { collectAfterPush } from './syncGc'
import type { RemoteContext } from './syncRemote'

function context(opts: { due?: boolean; fails?: ServerError } = {}) {
  const gc = vi.fn(async (..._args: unknown[]) => {
    if (opts.fails) throw opts.fails
    return { deleted: 1 }
  })
  const authed = vi.fn(
    async (work: (token: string, routes: { gc: typeof gc }) => Promise<unknown>) =>
      work('token', { gc }),
  )
  const signed = vi.fn(
    async (
      kind: string,
      send: (headers: Record<string, string>) => Promise<unknown>,
      bound: readonly string[],
    ) => {
      void kind
      void bound
      return send({ 'X-Device-Signature': 'sig' })
    },
  )
  const keyring = { gcDue: vi.fn(() => opts.due ?? true), gcDone: vi.fn() }
  return {
    ctx: {
      account: { authed, signer: () => ({ signed }) },
      keyring,
    } as unknown as RemoteContext,
    gc,
    signed,
    keyring,
  }
}

describe('automatic server clean-up', () => {
  it('SYA-C140 does nothing when it ran within the day', async () => {
    const { ctx, gc, keyring } = context({ due: false })
    await collectAfterPush(ctx, ['a'], 3)
    expect(gc).not.toHaveBeenCalled()
    expect(keyring.gcDone).not.toHaveBeenCalled()
  })

  it('SYA-C141 signs the version of the pushed manifest and the exact body', async () => {
    const { ctx, gc, signed, keyring } = context()
    await collectAfterPush(ctx, ['a', 'b'], 7)
    const json = JSON.stringify({ keep: ['a', 'b'] })
    expect(signed).toHaveBeenCalledWith('syncGc', expect.any(Function), ['7', digestOf(json)])
    expect(gc).toHaveBeenCalledWith('token', json, '7', { 'X-Device-Signature': 'sig' })
    expect(keyring.gcDone).toHaveBeenCalledTimes(1)
  })

  it.each([
    [429, 'rate-limited'],
    [403, 'device-too-new'],
    [412, 'version-mismatch'],
  ])(
    'SYA-C143 counts a %s answer as the day’s attempt and does not ask again',
    async (status, error) => {
      const { ctx, gc, keyring } = context({ fails: new ServerError(status, error) })
      await expect(collectAfterPush(ctx, ['a'], 7)).resolves.toBeUndefined()
      expect(gc).toHaveBeenCalledTimes(1)
      expect(keyring.gcDone).toHaveBeenCalledTimes(1)
    },
  )
})
