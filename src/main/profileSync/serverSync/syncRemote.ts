import type { ServerAccount } from '../../server/serverAccount'
import { ServerError } from '../../server/serverClient'
import { SyncTargetError } from '../engine'
import { profileFileLimit } from '../profile'
import { contentHash, type Manifest, openBlob, openManifest } from './syncCrypto'
import type { SyncKeyring } from './syncKeyring'

const FETCH_PARALLEL = 8
const SEALED_OVERHEAD = 28

export type RemoteAccount = Pick<ServerAccount, 'authed'>

export interface RemoteContext {
  account: RemoteAccount
  keyring: SyncKeyring
}

export interface Remote {
  key: Buffer
  version: number
  manifest: Manifest | null
  files: Map<string, Buffer>
  skipped: string[]
}

export interface BlobCache {
  get: (id: string) => Buffer | undefined
  set: (id: string, content: Buffer) => void
}

export function targetErrorOf(error: unknown): SyncTargetError {
  if (error instanceof SyncTargetError) return error
  if (error instanceof ServerError) {
    if (error.code === 'not-signed-in' || error.status === 401) {
      return new SyncTargetError('server-signed-out')
    }
    if (error.status === 507 || error.status === 413) return new SyncTargetError('server-quota')
  }
  return new SyncTargetError('server-unreachable')
}

async function inChunks<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += FETCH_PARALLEL) {
    await Promise.all(items.slice(i, i + FETCH_PARALLEL).map(run))
  }
}

export function uploadAll(
  ctx: RemoteContext,
  blobs: ReadonlyArray<{ id: string; sealed: Buffer }>,
): Promise<void> {
  return inChunks(blobs, async ({ id, sealed }) => {
    try {
      await ctx.account.authed((token, routes) => routes.putBlob(token, id, new Uint8Array(sealed)))
    } catch (error) {
      if (error instanceof ServerError && error.status === 409) {
        throw new SyncTargetError('server-corrupt')
      }
      throw error
    }
  })
}

async function fetchManifest(ctx: RemoteContext) {
  try {
    return await ctx.account.authed((token, routes) => routes.manifest(token))
  } catch (error) {
    if (error instanceof ServerError && error.status === 404) return null
    throw error
  }
}

export async function readRemote(ctx: RemoteContext, cache?: BlobCache): Promise<Remote> {
  let key = ctx.keyring.key()
  if (!key) throw new SyncTargetError('server-locked')
  const view = await fetchManifest(ctx)
  if (!view) return { key, version: 0, manifest: null, files: new Map(), skipped: [] }
  const sealed = Buffer.from(view.blob, 'base64url')
  let manifest = openManifest(key, sealed)
  if (!manifest && (await ctx.keyring.adoptOwnDeviceWrap())) {
    key = ctx.keyring.key() ?? key
    manifest = openManifest(key, sealed)
  }
  if (!manifest) throw new SyncTargetError('server-locked')
  if (manifest.counter < ctx.keyring.highest()) throw new SyncTargetError('stale-manifest')
  const files = new Map<string, Buffer>()
  const skipped: string[] = []
  const readKey = key
  const wanted = Object.entries(manifest.files).flatMap(([path, entry]) => {
    const limit = profileFileLimit(path)
    return limit === null ? [] : [{ path, entry, limit }]
  })
  await inChunks(wanted, async ({ path, entry, limit }) => {
    const cached = cache?.get(entry.blobId)
    if (cached) {
      files.set(path, cached)
      return
    }
    const bytes = await ctx.account.authed((token, routes) => routes.blob(token, entry.blobId))
    if (bytes.length > limit + SEALED_OVERHEAD) {
      skipped.push(path)
      return
    }
    const content = openBlob(readKey, path, bytes)
    if (!content || contentHash(content) !== entry.hash) {
      throw new SyncTargetError('server-corrupt')
    }
    cache?.set(entry.blobId, content)
    files.set(path, content)
  })
  ctx.keyring.raise(manifest.counter)
  return { key, version: view.version, manifest, files, skipped: skipped.sort() }
}
