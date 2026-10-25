import { createHash } from 'node:crypto'
import type { FakeServer, Handler } from './fakeServer'

const BLOB_ID = /^[A-Za-z0-9_-]{43}$/
const DEFAULT_QUOTA = 64 * 1024 * 1024
const DEFAULT_BLOB_MAX = 16 * 1024 * 1024

interface StoredManifest {
  version: number
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
    data.manifests.push({ version, blob, updatedAt: server.now() })
    return version
  }

  const putManifest: Handler = (req, res, body, raw) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const match = req.headers['if-match']
    if (match === undefined) {
      server.error(res, 428, 'precondition-required')
      return
    }
    const version = Number(match.replace(/"/g, '').trim())
    if (!Number.isInteger(version)) {
      server.error(res, 400, 'bad-request')
      return
    }
    if (
      !server.signed(
        req,
        res,
        auth.device,
        (s) =>
          `ostia-server/manifest-put/v1\n${auth.device.id}\n${s}\n${version}\n${createHash('sha256').update(raw).digest('base64url')}`,
        true,
      )
    ) {
      return
    }
    const data = dataOf(auth.device.accountId)
    const blob = stored(body.blob)
    if (!blob) {
      server.error(res, 400, 'bad-request')
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
      versions: data.manifests.map((m) => ({ version: m.version, updatedAt: m.updatedAt })),
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

  const listWraps: Handler = (req, res) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const data = dataOf(auth.device.accountId)
    server.reply(res, 200, {
      keyVersion: data.keyVersion,
      wraps: [...data.wraps].map(([slot, w]) => ({ slot, updatedAt: w.updatedAt })),
    })
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
    const found = dataOf(auth.device.accountId).wraps.get(slot ?? '')
    if (!found) server.error(res, 404, 'not-found')
    else server.reply(res, 200, { slot, blob: found.blob, updatedAt: found.updatedAt })
  }

  const putWrap: Handler = (req, res, body, _raw, [slot]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const { device } = auth
    const data = dataOf(device.accountId)
    const name = slot ?? ''
    const blob = stored(body.blob)
    if (!validSlot(name) || !blob) {
      server.error(res, 400, 'bad-slot')
      return
    }
    data.wraps.set(name, { blob, updatedAt: server.now() })
    res.writeHead(204).end()
  }

  const rotate: Handler = (req, res, body) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const data = dataOf(auth.device.accountId)
    const manifest = stored(body.manifest)
    const wraps = (body.wraps ?? {}) as Record<string, unknown>
    const passphrase = stored(wraps.passphrase)
    const recovery = stored(wraps.recovery)
    if (!manifest || !passphrase || !recovery || Object.keys(wraps).length !== 2) {
      server.error(res, 400, 'bad-request')
      return
    }
    if (Number(body.ifMatch) !== current(data)) {
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
    const match = req.headers['if-match']
    if (match === undefined) {
      server.error(res, 428, 'precondition-required')
      return
    }
    const version = Number(match.replace(/"/g, '').trim())
    if (!Number.isInteger(version)) {
      server.error(res, 400, 'bad-request')
      return
    }
    if (
      !server.signed(
        req,
        res,
        auth.device,
        (s) =>
          `ostia-server/sync-gc/v1\n${auth.device.id}\n${s}\n${version}\n${createHash('sha256').update(raw).digest('base64url')}`,
        true,
      )
    ) {
      return
    }
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
    ['GET', /^\/v1\/sync\/wraps$/, listWraps],
    ['GET', /^\/v1\/sync\/wraps\/([^/]+)$/, getWrap],
    ['PUT', /^\/v1\/sync\/wraps\/([^/]+)$/, putWrap],
    ['POST', /^\/v1\/sync\/rotate$/, rotate],
    ['POST', /^\/v1\/sync\/gc$/, gc],
    ['GET', /^\/v1\/sync\/usage$/, usage],
  ]
}
