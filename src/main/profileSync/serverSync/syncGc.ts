import { failureOf } from '../../server/serverAccount'
import type { RemoteContext } from './syncRemote'

export async function collectAfterPush(ctx: RemoteContext, keep: string[]): Promise<void> {
  if (!ctx.keyring.gcDue()) return
  try {
    await ctx.account.authed((token, routes) => routes.gc(token, keep))
    ctx.keyring.gcDone()
  } catch (error) {
    if (failureOf(error) !== 'elevation-required') ctx.keyring.gcDone()
  }
}
