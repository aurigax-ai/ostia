import { ServerError } from '../../server/serverClient'
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

const CHANGE_ATTEMPTS = 3

export type Rekey = (path: string, content: Buffer, from: Buffer, to: Buffer) => Buffer

type ChangeError = KeyringError | 'locked' | 'changed-elsewhere'

export type ChangeResult = { ok: true; recoveryKey: string } | { ok: false; error: ChangeError }

async function changeOnce(
  ctx: RemoteContext,
  key: Buffer,
  next: string,
  rekey: Rekey,
): Promise<'retry' | ChangeResult> {
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
  const wraps = await ctx.keyring.wraps(newKey, next)
  const body = {
    ifMatch: remote.version,
    manifest: sealManifest(newKey, { counter, files }).toString('base64url'),
    wraps: { passphrase: wraps.passphrase, recovery: wraps.recovery },
  }
  try {
    await ctx.account.authed((token, routes) => routes.rotate(token, body))
  } catch (error) {
    if (error instanceof ServerError && error.status === 412) return 'retry'
    throw error
  }
  if (!ctx.keyring.keep(newKey)) return { ok: false, error: 'unavailable' }
  ctx.keyring.raise(counter)
  return { ok: true, recoveryKey: wraps.recoveryKey }
}

export async function changePassphrase(
  ctx: RemoteContext,
  current: string,
  next: string,
  confirm: string,
  rekey: Rekey,
): Promise<ChangeResult> {
  const problem = passphraseProblem(next, confirm)
  if (problem) return { ok: false, error: problem }
  const key = ctx.keyring.key()
  if (!key) return { ok: false, error: 'locked' }
  try {
    const opened = await ctx.keyring.openWrap('passphrase', current)
    if (!opened?.equals(key)) return { ok: false, error: 'wrong-password' }
    for (let attempt = 0; attempt < CHANGE_ATTEMPTS; attempt++) {
      const done = await changeOnce(ctx, key, next, rekey)
      if (done !== 'retry') return done
    }
    return { ok: false, error: 'changed-elsewhere' }
  } catch (error) {
    return { ok: false, error: keyringErrorOf(error) }
  }
}
