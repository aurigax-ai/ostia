import { type Manifest, type ManifestDevice, sealManifest } from './syncCrypto'
import { type RemoteContext, readRemote } from './syncRemote'

const sameDevice = (a: ManifestDevice, b: ManifestDevice): boolean =>
  a.id === b.id && a.name === b.name && a.signPub === b.signPub && a.boxPub === b.boxPub

export async function registerInManifest(
  ctx: RemoteContext,
  self: ManifestDevice | null,
): Promise<number | null> {
  const key = ctx.keyring.key()
  if (!key || !self) return null
  try {
    const remote = await readRemote(ctx)
    const known = remote.manifest?.devices ?? []
    if (known.some((d) => sameDevice(d, self))) return remote.manifest?.counter ?? null
    const counter = Math.max(remote.manifest?.counter ?? 0, ctx.keyring.highest()) + 1
    const manifest: Manifest = {
      counter,
      files: remote.manifest?.files ?? {},
      devices: [...known.filter((d) => d.id !== self.id), self],
    }
    const sealed = sealManifest(key, manifest).toString('base64url')
    await ctx.account.authed((token, routes) =>
      routes.putManifest(token, sealed, String(remote.version)),
    )
    ctx.keyring.raise(counter)
    ctx.keyring.pin(manifest.devices)
    return counter
  } catch {
    return null
  }
}
