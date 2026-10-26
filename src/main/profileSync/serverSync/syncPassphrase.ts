import { digestOf } from '../../server/deviceKeys'
import { ServerError } from '../../server/serverClient'
import { normalizeRecoveryKey } from '../secretCrypto'
import {
  blobId,
  contentHash,
  type Manifest,
  newProfileKey,
  sealBlob,
  sealManifest,
} from './syncCrypto'
import { type KeyringError, keyringErrorOf, passphraseProblem } from './syncKeyring'
import { type RemoteContext, readRemote, uploadAll } from './syncRemote'

const REPLACE_ATTEMPTS = 3

export type Rekey = (path: string, content: Buffer, from: Buffer, to: Buffer) => Buffer

type ReplaceError = KeyringError | 'locked' | 'changed-elsewhere'

export type ReplaceResult = { ok: true; recoveryKey: string } | { ok: false; error: ReplaceError }

class VersionMoved extends Error {}

async function pushKey(
  ctx: RemoteContext,
  key: Buffer,
  passphrase: string,
  manifest: Manifest,
  ifMatch: number,
): Promise<ReplaceResult> {
  const wraps = await ctx.keyring.wraps(key, passphrase)
  const json = JSON.stringify({
    manifest: sealManifest(key, manifest).toString('base64url'),
    passphrase: wraps.passphrase,
    recovery: wraps.recovery,
  })
  const match = String(ifMatch)
  try {
    await ctx.account.authed((token, routes) =>
      ctx.account
        .signer()
        .signed('syncRotate', (headers) => routes.rotate(token, json, match, headers), [
          match,
          digestOf(json),
        ]),
    )
  } catch (error) {
    if (error instanceof ServerError && error.status === 412) throw new VersionMoved()
    throw error
  }
  if (!ctx.keyring.keep(key)) return { ok: false, error: 'unavailable' }
  ctx.keyring.raise(manifest.counter)
  return { ok: true, recoveryKey: wraps.recoveryKey }
}

async function replaceOnce(
  ctx: RemoteContext,
  key: Buffer,
  next: string,
  rekey: Rekey,
): Promise<ReplaceResult> {
  const remote = await readRemote(ctx, undefined, true)
  const newKey = newProfileKey()
  const files: Manifest['files'] = {}
  const uploads: Array<{ id: string; sealed: Buffer }> = []
  for (const [path, content] of remote.files) {
    const moved = rekey(path, content, key, newKey)
    const id = blobId(newKey, path, moved)
    files[path] = { blobId: id, hash: contentHash(moved) }
    uploads.push({ id, sealed: sealBlob(newKey, path, moved) })
  }
  await uploadAll(ctx, uploads)
  const counter = Math.max(remote.manifest?.counter ?? 0, ctx.keyring.highest()) + 1
  return pushKey(ctx, newKey, next, { counter, files }, remote.version)
}

async function replaceKey(
  ctx: RemoteContext,
  key: Buffer,
  next: string,
  rekey: Rekey,
): Promise<ReplaceResult> {
  for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
    try {
      return await replaceOnce(ctx, key, next, rekey)
    } catch (error) {
      if (!(error instanceof VersionMoved)) throw error
    }
  }
  return { ok: false, error: 'changed-elsewhere' }
}

export async function setupKey(
  ctx: RemoteContext,
  passphrase: string,
  confirm: string,
): Promise<ReplaceResult> {
  const problem = passphraseProblem(passphrase, confirm)
  if (problem) return { ok: false, error: problem }
  try {
    const counter = ctx.keyring.highest() + 1
    return await pushKey(ctx, newProfileKey(), passphrase, { counter, files: {} }, 0)
  } catch (error) {
    if (error instanceof VersionMoved) return { ok: false, error: 'exists' }
    return { ok: false, error: keyringErrorOf(error) }
  }
}

export async function changePassphrase(
  ctx: RemoteContext,
  current: string,
  next: string,
  confirm: string,
  rekey: Rekey,
): Promise<ReplaceResult> {
  const problem = passphraseProblem(next, confirm)
  if (problem) return { ok: false, error: problem }
  const key = ctx.keyring.key()
  if (!key) return { ok: false, error: 'locked' }
  try {
    const opened = await ctx.keyring.openWrap('passphrase', current)
    if (!opened?.equals(key)) return { ok: false, error: 'wrong-password' }
    return await replaceKey(ctx, key, next, rekey)
  } catch (error) {
    return { ok: false, error: keyringErrorOf(error) }
  }
}

export async function recoverWithKey(
  ctx: RemoteContext,
  recoveryKey: string,
  next: string,
  confirm: string,
  rekey: Rekey,
): Promise<ReplaceResult> {
  const problem = passphraseProblem(next, confirm)
  if (problem) return { ok: false, error: problem }
  const opened = await ctx.keyring.opened(
    'recovery',
    normalizeRecoveryKey(recoveryKey),
    'wrong-recovery-key',
  )
  if (!opened.ok) return opened
  if (!ctx.keyring.keep(opened.key)) return { ok: false, error: 'unavailable' }
  try {
    return await replaceKey(ctx, opened.key, next, rekey)
  } catch (error) {
    return { ok: false, error: keyringErrorOf(error) }
  }
}
