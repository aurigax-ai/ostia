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
      const info = await routes.info()
      if (info.syncGcBound === true) await routes.gc(token, keep, version)
    })
  } catch {}
}
