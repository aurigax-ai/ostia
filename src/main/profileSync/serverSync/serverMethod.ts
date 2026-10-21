import type { ServerAccount } from '../../server/serverAccount'
import { ServerError } from '../../server/serverClient'
import { type SyncMethod, type SyncSnapshot, SyncTargetError, type WriteResult } from '../engine'
import {
  blobId,
  contentHash,
  type Manifest,
  type ManifestDevice,
  sealBlob,
  sealManifest,
} from './syncCrypto'
import type { SyncKeyring } from './syncKeyring'
import { type RemoteContext, readRemote, targetErrorOf, uploadAll } from './syncRemote'

const FIRST_VERSION = '0'
const CACHE_MAX = 600

interface MethodContext extends RemoteContext {
  self: () => ManifestDevice | null
}

class ServerMethod implements SyncMethod {
  private last: { version: number; manifest: Manifest | null } = { version: 0, manifest: null }
  private readonly cache = new Map<string, Buffer>()

  constructor(
    private readonly ctx: MethodContext,
    readonly id: string,
  ) {}

  private get keyring(): SyncKeyring {
    return this.ctx.keyring
  }

  async read(): Promise<SyncSnapshot> {
    try {
      const remote = await readRemote(this.ctx, {
        get: (id) => this.cache.get(id),
        set: (id, content) => {
          if (this.cache.size >= CACHE_MAX) this.cache.clear()
          this.cache.set(id, content)
        },
      })
      this.last = { version: remote.version, manifest: remote.manifest }
      const files = new Map<string, string>()
      for (const [path, content] of remote.files) files.set(path, content.toString('utf8'))
      return {
        files,
        version: remote.version === 0 ? FIRST_VERSION : String(remote.version),
        skipped: remote.skipped,
      }
    } catch (error) {
      throw targetErrorOf(error)
    }
  }

  async write(files: ReadonlyMap<string, string>, expected: string): Promise<WriteResult> {
    const key = this.keyring.key()
    if (!key) throw new SyncTargetError('server-locked')
    const counter = Math.max(this.last.manifest?.counter ?? 0, this.keyring.highest()) + 1
    const entries: Manifest['files'] = {}
    const uploads: Array<{ id: string; sealed: Buffer }> = []
    for (const [path, text] of files) {
      const content = Buffer.from(text, 'utf8')
      const id = blobId(key, path, content)
      entries[path] = { blobId: id, hash: contentHash(content) }
      if (this.last.manifest?.files[path]?.blobId !== id) {
        uploads.push({ id, sealed: sealBlob(key, path, content) })
      }
    }
    const self = this.ctx.self()
    const manifest: Manifest = { counter, files: entries, devices: self ? [self] : [] }
    try {
      await uploadAll(this.ctx, uploads)
      const sealed = sealManifest(key, manifest).toString('base64url')
      const put = await this.ctx.account.authed((token, routes) =>
        routes.putManifest(token, sealed, expected),
      )
      this.keyring.raise(counter)
      return { ok: true, version: String(put.version) }
    } catch (error) {
      if (error instanceof ServerError && error.status === 412) return { ok: false }
      throw targetErrorOf(error)
    }
  }
}

const SIGNED_OUT_ID = 'server:signed-out'

const signedOutMethod: SyncMethod = {
  id: SIGNED_OUT_ID,
  read: () => Promise.reject(new SyncTargetError('server-signed-out')),
  write: () => Promise.reject(new SyncTargetError('server-signed-out')),
}

export type TargetAccount = RemoteContext['account'] & Pick<ServerAccount, 'identity'>

export function createServerTarget(account: TargetAccount, keyring: SyncKeyring) {
  let current: ServerMethod | null = null
  return {
    method: (): SyncMethod => {
      const target = keyring.target()
      if (!target) return signedOutMethod
      const id = `server:${target.id}`
      if (current?.id !== id) {
        current = new ServerMethod(
          {
            account,
            keyring,
            self: () => {
              const identity = account.identity()
              return identity ? { id: identity.deviceId, name: identity.deviceName } : null
            },
          },
          id,
        )
      }
      return current
    },
    label: (): string => keyring.target()?.host ?? 'server',
  }
}
