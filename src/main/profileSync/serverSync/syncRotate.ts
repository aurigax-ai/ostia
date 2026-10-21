import { failureOf } from '../../server/serverAccount'
import { ServerError } from '../../server/serverClient'
import { normalizeRecoveryKey } from '../secretCrypto'
import {
  blobId,
  contentHash,
  type Manifest,
  type ManifestDevice,
  newProfileKey,
  sealBlob,
  sealManifest,
  wrapWithSecret,
} from './syncCrypto'
import { localPublicKeys } from './syncLink'
import { type Remote, type RemoteContext, readRemote, uploadAll } from './syncRemote'

const ROTATE_ATTEMPTS = 3

export type RotateError =
  | 'untrusted'
  | 'wrong-password'
  | 'wrong-recovery-key'
  | 'elevation-required'
  | 'locked'
  | 'rotation-failed'

export type RotateResult =
  | { ok: true; recoveryStale: boolean; unwrapped: string[] }
  | { ok: false; error: RotateError }

async function resealed(ctx: RemoteContext, remote: Remote, newKey: Buffer) {
  const entries: Manifest['files'] = {}
  const uploads: Array<{ id: string; sealed: Buffer }> = []
  for (const [path, content] of remote.files) {
    const id = blobId(newKey, path, content)
    entries[path] = { blobId: id, hash: contentHash(content) }
    uploads.push({ id, sealed: sealBlob(newKey, path, content) })
  }
  await uploadAll(ctx, uploads)
  return entries
}

export async function verifySecrets(
  ctx: RemoteContext,
  passphrase: string,
  recoveryKey: string,
): Promise<RotateError | null> {
  const key = ctx.keyring.key()
  if (!key) return 'locked'
  if (!(await ctx.keyring.verifySecret('passphrase', passphrase, key))) return 'wrong-password'
  const recovery = recoveryKey.trim()
  if (
    recovery &&
    !(await ctx.keyring.verifySecret('recovery', normalizeRecoveryKey(recovery), key))
  ) {
    return 'wrong-recovery-key'
  }
  return null
}

async function rotateOnce(
  ctx: RemoteContext,
  passphrase: string,
  recoveryKey: string,
): Promise<'retry' | RotateResult> {
  const remote = await readRemote(ctx, undefined, true)
  const newKey = newProfileKey()
  const files = await resealed(ctx, remote, newKey)
  const listed = await ctx.account.authed((token, routes) => routes.devices(token))
  const keys = ctx.account.deviceKeys()
  const trusted = ctx.keyring.trusted()
  const self = listed.devices.filter((d) => d.current === true)
  const local = keys ? localPublicKeys(keys) : null
  const me = self[0]
  if (!local || self.length !== 1 || me?.signPub !== local.signPub || me?.boxPub !== local.boxPub) {
    return { ok: false, error: 'untrusted' }
  }
  const devices: ManifestDevice[] = [
    {
      id: me.id,
      name: me.name,
      signPub: local.signPub,
      boxPub: local.boxPub,
      createdAt: trusted.find((d) => d.id === me.id)?.createdAt ?? ctx.keyring.now(),
    },
  ]
  const unwrapped: string[] = []
  for (const row of listed.devices) {
    if (row.current === true) continue
    const pinned = trusted.find(
      (d) => d.id === row.id && d.signPub === row.signPub && d.boxPub === row.boxPub,
    )
    if (pinned) devices.push(pinned)
    else unwrapped.push(row.name)
  }
  const counter = Math.max(remote.manifest?.counter ?? 0, ctx.keyring.highest()) + 1
  const manifest: Manifest = { counter, files, devices }
  const wraps: Record<string, string> = {
    passphrase: (await wrapWithSecret(newKey, passphrase, ctx.keyring.cost)).toString('base64url'),
  }
  const keepRecovery = recoveryKey.trim() !== ''
  if (keepRecovery) {
    wraps.recovery = (
      await wrapWithSecret(newKey, normalizeRecoveryKey(recoveryKey), ctx.keyring.cost)
    ).toString('base64url')
  }
  for (const device of devices) {
    const blob = ctx.keyring.wrapFor(device.boxPub, device.id, newKey, counter)
    if (!blob) return { ok: false, error: 'untrusted' }
    wraps[`device:${device.id}`] = blob
  }
  const body = {
    ifMatch: remote.version,
    manifest: sealManifest(newKey, manifest).toString('base64url'),
    wraps,
    deleteSlots: keepRecovery ? [] : ['recovery'],
  }
  try {
    await ctx.account.authed((token, routes) => routes.rotate(token, body))
  } catch (error) {
    if (error instanceof ServerError && error.status === 412) return 'retry'
    throw error
  }
  ctx.keyring.keep(newKey)
  ctx.keyring.raise(counter)
  ctx.keyring.pin(devices)
  return { ok: true, recoveryStale: !keepRecovery, unwrapped }
}

export async function rotateKey(
  ctx: RemoteContext,
  passphrase: string,
  recoveryKey: string,
): Promise<RotateResult> {
  const refused = await verifySecrets(ctx, passphrase, recoveryKey)
  if (refused) return { ok: false, error: refused }
  try {
    for (let attempt = 0; attempt < ROTATE_ATTEMPTS; attempt++) {
      const done = await rotateOnce(ctx, passphrase, recoveryKey)
      if (done !== 'retry') return done
    }
  } catch (error) {
    if (failureOf(error) === 'elevation-required') return { ok: false, error: 'elevation-required' }
  }
  return { ok: false, error: 'rotation-failed' }
}

export async function collectGarbage(
  ctx: RemoteContext,
): Promise<{ ok: true; deleted: number } | { ok: false; error: RotateError }> {
  try {
    const remote = await readRemote(ctx)
    const keep = Object.values(remote.manifest?.files ?? {}).map((f) => f.blobId)
    const { deleted } = await ctx.account.authed((token, routes) => routes.gc(token, keep))
    return { ok: true, deleted }
  } catch (error) {
    return {
      ok: false,
      error: failureOf(error) === 'elevation-required' ? 'elevation-required' : 'rotation-failed',
    }
  }
}
