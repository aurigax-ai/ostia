import { digestOf } from '../../server/deviceKeys'
import type { RemoteContext } from './syncRemote'

export async function collectAfterPush(
  ctx: RemoteContext,
  keep: string[],
  version: number,
): Promise<void> {
  if (!ctx.keyring.gcDue()) return
  ctx.keyring.gcDone()
  try {
    await ctx.account.authed(async (token, routes) => {
      const json = JSON.stringify({ keep })
      const ifMatch = String(version)
      await ctx.account
        .signer()
        .signed('syncGc', (headers) => routes.gc(token, json, ifMatch, headers), [
          ifMatch,
          digestOf(json),
        ])
    })
  } catch {}
}
