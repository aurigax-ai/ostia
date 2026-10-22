import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FakeServer, Handler } from './fakeServer'

const SALT_BYTES = 16
const DAY_S = 86_400
const MIN_EXPIRY_S = 60
const MAX_EXPIRY_S = 365 * DAY_S
const DEFAULT_EXPIRY_S = 30 * DAY_S
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_SHARES = 100
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

export interface FakeShare {
  id: string
  accountId: string
  mode: string
  salt: string | null
  size: number
  expiresAt: number
  deleteToken: string
  createdAt: number
  blob: Buffer | null
  views: number
}

function newId(): string {
  return Array.from(randomBytes(26), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')
}

export function shareRoutes(server: FakeServer): Array<[string, RegExp, Handler]> {
  const maxBytes = server.options.shareMaxBytes ?? DEFAULT_MAX_BYTES
  const accountOf = (req: IncomingMessage, res: ServerResponse) => {
    const auth = server.authed(req, res)
    return auth ? auth.device.accountId : null
  }
  const expired = (share: FakeShare): boolean =>
    share.expiresAt !== 0 && share.expiresAt <= server.now()

  const create: Handler = (req, res, body) => {
    const accountId = accountOf(req, res)
    if (accountId === null) return
    const { mode, size, expiresInSeconds, salt } = body
    if (mode !== 'link' && mode !== 'password' && mode !== 'public') {
      server.error(res, 400, 'bad-request')
      return
    }
    if (mode === 'password' && Buffer.from(String(salt ?? ''), 'base64url').length !== SALT_BYTES) {
      server.error(res, 400, 'bad-request')
      return
    }
    if (mode === 'public' && server.options.allowPublic !== true) {
      server.error(res, 403, 'public-disabled')
      return
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > maxBytes) {
      server.error(res, 413, 'too-large')
      return
    }
    let seconds = DEFAULT_EXPIRY_S
    if (expiresInSeconds !== undefined) {
      if (typeof expiresInSeconds !== 'number') {
        server.error(res, 400, 'bad-request')
        return
      }
      seconds = expiresInSeconds
    }
    const never = seconds === 0
    if (
      (never && server.options.allowNever !== true) ||
      (!never && (seconds < MIN_EXPIRY_S || seconds > MAX_EXPIRY_S))
    ) {
      server.error(res, 400, 'bad-request')
      return
    }
    const mine = [...server.shares.values()].filter((s) => s.accountId === accountId)
    if (mine.length >= (server.options.maxShares ?? DEFAULT_MAX_SHARES)) {
      server.error(res, 507, 'quota-exceeded')
      return
    }
    const share: FakeShare = {
      id: newId(),
      accountId,
      mode,
      salt: mode === 'password' ? String(salt) : null,
      size,
      expiresAt: never ? 0 : server.now() + seconds * 1000,
      deleteToken: randomBytes(24).toString('base64url'),
      createdAt: server.now(),
      blob: null,
      views: 0,
    }
    server.shares.set(share.id, share)
    server.reply(res, 201, {
      id: share.id,
      url: `${server.url}/s/${share.id}`,
      uploadUrl: `${server.url}/v1/shares/${share.id}/blob`,
      deleteToken: share.deleteToken,
      expiresAt: share.expiresAt,
    })
  }

  const list: Handler = (req, res) => {
    const accountId = accountOf(req, res)
    if (accountId === null) return
    const shares = [...server.shares.values()]
      .filter((s) => s.accountId === accountId)
      .map((s) => ({
        id: s.id,
        url: `${server.url}/s/${s.id}`,
        mode: s.mode,
        size: s.size,
        views: s.views,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        uploaded: s.blob !== null,
        ...(expired(s) ? { expired: true } : {}),
      }))
    server.reply(res, 200, { shares })
  }

  const upload: Handler = (req, res, _body, raw, [id]) => {
    const accountId = accountOf(req, res)
    if (accountId === null) return
    const share = server.shares.get(id ?? '')
    if (!share || share.accountId !== accountId) {
      server.error(res, 404, 'not-found')
      return
    }
    if (share.blob) {
      server.error(res, 409, 'already-uploaded')
      return
    }
    if (raw.length !== share.size) {
      server.error(res, 400, 'size-mismatch')
      return
    }
    share.blob = Buffer.from(raw)
    res.writeHead(204).end()
  }

  const remove: Handler = (req, res, _body, _raw, [id]) => {
    const share = server.shares.get(id ?? '')
    const token = String(req.headers['x-delete-token'] ?? '')
    let allowed = false
    if (share && token) allowed = token === share.deleteToken
    else if (share && req.headers.authorization) {
      const auth = server.authed(req, res)
      if (!auth) return
      allowed = auth.device.accountId === share.accountId
    }
    if (!share || !allowed) {
      server.error(res, 404, 'not-found')
      return
    }
    server.shares.delete(share.id)
    res.writeHead(204).end()
  }

  const hosted = (res: ServerResponse, id: string | undefined): FakeShare | null => {
    const share = server.shares.get(id ?? '')
    if (!share?.blob) {
      server.error(res, 404, 'not-found')
      return null
    }
    if (expired(share)) {
      server.error(res, 410, 'gone')
      return null
    }
    return share
  }

  const meta: Handler = (_req, res, _body, _raw, [id]) => {
    const share = hosted(res, id)
    if (!share) return
    server.reply(res, 200, {
      v: 1,
      mode: share.mode,
      size: share.size,
      salt: share.salt ?? '',
      expiresAt: share.expiresAt,
    })
  }

  const blob: Handler = (_req, res, _body, _raw, [id]) => {
    const share = hosted(res, id)
    if (!share?.blob) return
    share.views += 1
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(share.blob)
  }

  const page: Handler = (_req, res, _body, _raw, [id]) => {
    const share = hosted(res, id)
    if (!share?.blob) return
    if (share.mode === 'public') {
      share.views += 1
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': 'sandbox allow-scripts',
      })
      res.end(share.blob)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Shared artifact</title>')
  }

  return [
    ['POST', /^\/v1\/shares$/, create],
    ['GET', /^\/v1\/shares$/, list],
    ['PUT', /^\/v1\/shares\/([a-z2-7]+)\/blob$/, upload],
    ['DELETE', /^\/v1\/shares\/([a-z2-7]+)$/, remove],
    ['GET', /^\/s\/([a-z2-7]+)\/meta$/, meta],
    ['GET', /^\/s\/([a-z2-7]+)\/blob$/, blob],
    ['GET', /^\/s\/([a-z2-7]+)\/?$/, page],
  ]
}
