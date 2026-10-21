import { type Manifest, type ManifestDevice, sealManifest } from './syncCrypto'
import { type RemoteContext, readRemote } from './syncRemote'

export async function registerInManifest(
  ctx: RemoteContext,
  self: ManifestDevice | null,
): Promise<void> {
  const key = ctx.keyring.key()
  if (!key || !self) return
  try {
    const remote = await readRemote(ctx)
    const known = remote.manifest?.devices ?? []
    if (known.some((d) => d.id === self.id)) return
    const counter = Math.max(remote.manifest?.counter ?? 0, ctx.keyring.highest()) + 1
    const manifest: Manifest = {
      counter,
      files: remote.manifest?.files ?? {},
      devices: [...known, self],
    }
    const sealed = sealManifest(key, manifest).toString('base64url')
    await ctx.account.authed((token, routes) =>
      routes.putManifest(token, sealed, String(remote.version)),
    )
    ctx.keyring.raise(counter)
  } catch {}
}
