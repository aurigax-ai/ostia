import { createHash } from 'node:crypto'
import type { FakeServer, Handler } from './fakeServer'

const BLOB_ID = /^[A-Za-z0-9_-]{43}$/
const DEFAULT_QUOTA = 64 * 1024 * 1024
const DEFAULT_BLOB_MAX = 16 * 1024 * 1024

interface StoredManifest {
  version: number
  keyVersion: number
  blob: string
  updatedAt: number
}

interface StoredWrap {
  blob: string
  updatedAt: number
}

export interface AccountSync {
  manifests: StoredManifest[]
  blobs: Map<string, { bytes: Buffer; at: number }>
  wraps: Map<string, StoredWrap>
  keyVersion: number
}

const validSlot = (slot: string): boolean => slot === 'passphrase' || slot === 'recovery'

function stored(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(value) ? value : null
}

export function syncRoutes(server: FakeServer): Array<[string, RegExp, Handler]> {
  const dataOf = (accountId: string): AccountSync => {
    let data = server.syncData.get(accountId)
    if (!data) {
      data = { manifests: [], blobs: new Map(), wraps: new Map(), keyVersion: 0 }
      server.syncData.set(accountId, data)
    }
    return data
  }
  const bytesUsed = (data: AccountSync): number =>
    [...data.blobs.values()].reduce((sum, b) => sum + b.bytes.length, 0)
  const current = (data: AccountSync): number => data.manifests.at(-1)?.version ?? 0
  const quota = server.options.quotaBytes ?? DEFAULT_QUOTA

  const getManifest: Handler = (req, res) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const data = dataOf(auth.device.accountId)
    const wanted = new URL(req.url ?? '', 'http://x').searchParams.get('version')
    const found = wanted
      ? data.manifests.find((m) => m.version === Number(wanted))
      : data.manifests.at(-1)
    if (!found) server.error(res, 404, 'no-manifest')
    else server.reply(res, 200, found)
  }

  const commitManifest = (data: AccountSync, blob: string): number => {
    const version = current(data) + 1
    data.manifests.push({ version, keyVersion: data.keyVersion, blob, updatedAt: server.now() })
    return version
  }

  const ifMatchOf = (req: Parameters<Handler>[0], res: Parameters<Handler>[1]): number | null => {
    const match = req.headers['if-match']
    if (match === undefined) {
      server.error(res, 428, 'precondition-required')
      return null
    }
    const version = Number(match.replace(/"/g, '').trim())
    if (!Number.isInteger(version)) {
      server.error(res, 400, 'bad-request')
      return null
    }
    return version
  }

  const bodySigned = (
    req: Parameters<Handler>[0],
    res: Parameters<Handler>[1],
    auth: NonNullable<ReturnType<FakeServer['authed']>>,
    action: string,
    version: number,
    raw: Buffer,
  ): boolean =>
    server.signed(
      req,
      res,
      auth.device,
      (s) =>
        `ostia-server/${action}/v1\n${auth.device.id}\n${s}\n${version}\n${createHash('sha256').update(raw).digest('base64url')}`,
      true,
    )

  const putManifest: Handler = (req, res, body, raw) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const version = ifMatchOf(req, res)
    if (version === null || !bodySigned(req, res, auth, 'manifest-put', version, raw)) return
    const data = dataOf(auth.device.accountId)
    const blob = stored(body.blob)
    if (!blob) {
      server.error(res, 400, 'bad-request')
      return
    }
    if (data.keyVersion === 0) {
      server.error(res, 409, 'no-key')
      return
    }
    if (version !== current(data)) {
      server.reply(res, 412, { error: 'version-mismatch', current: current(data) })
      return
    }
    server.reply(res, 200, { version: commitManifest(data, blob) })
  }

  const manifestVersions: Handler = (req, res) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const data = dataOf(auth.device.accountId)
    server.reply(res, 200, {
      versions: data.manifests.map((m) => ({
        version: m.version,
        keyVersion: m.keyVersion,
        updatedAt: m.updatedAt,
      })),
    })
  }

  const getBlob: Handler = (req, res, _body, _raw, [id]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const found = dataOf(auth.device.accountId).blobs.get(id ?? '')
    if (!found) {
      server.error(res, 404, 'not-found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end(found.bytes)
  }

  const putBlob: Handler = (req, res, _body, raw, [id]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const data = dataOf(auth.device.accountId)
    if (!BLOB_ID.test(id ?? '')) {
      server.error(res, 400, 'bad-request')
      return
    }
    const existing = data.blobs.get(id ?? '')
    if (existing) {
      if (existing.bytes.equals(raw)) res.writeHead(200).end()
      else server.error(res, 409, 'blob-exists')
      return
    }
    if (raw.length > (server.options.maxBlobBytes ?? DEFAULT_BLOB_MAX)) {
      server.error(res, 413, 'too-large')
      return
    }
    if (bytesUsed(data) + raw.length > quota) {
      server.error(res, 507, 'quota-exceeded')
      return
    }
    data.blobs.set(id ?? '', { bytes: Buffer.from(raw), at: server.now() })
    res.writeHead(201).end()
  }

  const getWrap: Handler = (req, res, _body, _raw, [slot]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    if (
      (slot === 'passphrase' || slot === 'recovery') &&
      !server.signed(
        req,
        res,
        auth.device,
        (s) => `ostia-server/wrap-read/v1\n${auth.device.id}\n${s}\n${slot}`,
        true,
      )
    ) {
      return
    }
    if (!validSlot(slot ?? '')) {
      server.error(res, 400, 'bad-slot')
      return
    }
    const data = dataOf(auth.device.accountId)
    const found = data.wraps.get(slot ?? '')
    if (!found) server.error(res, 404, 'not-found')
    else {
      server.reply(res, 200, {
        slot,
        blob: found.blob,
        keyVersion: data.keyVersion,
        updatedAt: found.updatedAt,
      })
    }
  }

  const rotate: Handler = (req, res, body, raw) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const version = ifMatchOf(req, res)
    if (version === null || !bodySigned(req, res, auth, 'sync-rotate', version, raw)) return
    const data = dataOf(auth.device.accountId)
    const manifest = stored(body.manifest)
    const passphrase = stored(body.passphrase)
    const recovery = stored(body.recovery)
    if (!manifest || !passphrase || !recovery) {
      server.error(res, 400, 'bad-request')
      return
    }
    if (version !== current(data)) {
      server.reply(res, 412, { error: 'version-mismatch', current: current(data) })
      return
    }
    data.wraps.set('passphrase', { blob: passphrase, updatedAt: server.now() })
    data.wraps.set('recovery', { blob: recovery, updatedAt: server.now() })
    data.keyVersion += 1
    server.reply(res, 200, { version: commitManifest(data, manifest), keyVersion: data.keyVersion })
  }

  const gc: Handler = (req, res, body, raw) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const version = ifMatchOf(req, res)
    if (version === null || !bodySigned(req, res, auth, 'sync-gc', version, raw)) return
    const data = dataOf(auth.device.accountId)
    if (version !== current(data)) {
      server.reply(res, 412, { error: 'version-mismatch', current: current(data) })
      return
    }
    const keep = new Set(Array.isArray(body.keep) ? body.keep.map(String) : [])
    let deleted = 0
    for (const [id, blob] of data.blobs) {
      if (!keep.has(id) && server.now() - blob.at >= (server.options.gcGraceMs ?? 0)) {
        data.blobs.delete(id)
        deleted += 1
      }
    }
    server.reply(res, 200, { deleted })
  }

  const usage: Handler = (req, res) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const data = dataOf(auth.device.accountId)
    server.reply(res, 200, { blobs: data.blobs.size, bytes: bytesUsed(data), quotaBytes: quota })
  }

  return [
    ['GET', /^\/v1\/sync\/manifest$/, getManifest],
    ['PUT', /^\/v1\/sync\/manifest$/, putManifest],
    ['GET', /^\/v1\/sync\/manifest\/versions$/, manifestVersions],
    ['GET', /^\/v1\/sync\/blobs\/([^/]+)$/, getBlob],
    ['PUT', /^\/v1\/sync\/blobs\/([^/]+)$/, putBlob],
    ['GET', /^\/v1\/sync\/wraps\/([^/]+)$/, getWrap],
    ['POST', /^\/v1\/sync\/rotate$/, rotate],
    ['POST', /^\/v1\/sync\/gc$/, gc],
    ['GET', /^\/v1\/sync\/usage$/, usage],
  ]
}
