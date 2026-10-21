import { randomBytes } from 'node:crypto'
import type { FakeServer, Handler } from './fakeServer'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const TICKET_TTL_MS = 600_000
const TICKET_BURST = 3
const TICKET_WINDOW_MS = 600_000
const PING_GAP_MS = 30_000
const PINGS_PER_HOUR = 60
const HOUR_MS = 3_600_000
const DEFAULT_MAX_HANDLES = 20

export interface FakePushHandle {
  handle: string
  accountId: string
  platform: string
  token: string
  createdAt: number
}

export interface FakePushPing {
  handle: string
  at: number
  platform: string
  token: string
  contentType: string | undefined
}

export interface PushState {
  tickets: Map<string, { accountId: string; expiresAt: number }>
  handles: Map<string, FakePushHandle>
  pings: FakePushPing[]
  deleted: string[]
  invalidTokens: Set<string>
}

export function newPushState(): PushState {
  return {
    tickets: new Map(),
    handles: new Map(),
    pings: [],
    deleted: [],
    invalidTokens: new Set(),
  }
}

function newHandle(): string {
  return Array.from(randomBytes(32), (b) => ALPHABET[b % ALPHABET.length]).join('')
}

export function pushRoutes(server: FakeServer): Array<[string, RegExp, Handler]> {
  const { tickets, handles, pings, deleted, invalidTokens } = server.push
  const ticketTimes = new Map<string, number[]>()
  const pingTimes = new Map<string, number[]>()
  const max = server.options.pushMaxHandles ?? DEFAULT_MAX_HANDLES

  const mint: Handler = (req, res) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const accountId = auth.device.accountId
    const now = server.now()
    const recent = (ticketTimes.get(accountId) ?? []).filter((at) => now - at < TICKET_WINDOW_MS)
    if (recent.length >= TICKET_BURST) {
      ticketTimes.set(accountId, recent)
      server.error(res, 429, 'rate-limited', { 'Retry-After': '600' })
      return
    }
    ticketTimes.set(accountId, [...recent, now])
    const ticket = randomBytes(32).toString('base64url')
    const expiresAt = now + TICKET_TTL_MS
    tickets.set(ticket, { accountId, expiresAt })
    server.reply(res, 201, { ticket, expiresAt })
  }

  const register: Handler = (_req, res, body) => {
    const { platform, token, ticket } = body
    if (platform !== 'fcm' && platform !== 'apns') {
      server.error(res, 400, 'bad-request')
      return
    }
    if (typeof token !== 'string' || token === '' || token.length > 4096) {
      server.error(res, 400, 'bad-request')
      return
    }
    const held = typeof ticket === 'string' ? tickets.get(ticket) : undefined
    if (typeof ticket !== 'string' || !held || held.expiresAt <= server.now()) {
      server.error(res, 403, 'invalid-ticket')
      return
    }
    tickets.delete(ticket)
    const mine = [...handles.values()]
      .filter((h) => h.accountId === held.accountId)
      .sort((a, b) => a.createdAt - b.createdAt)
    if (mine.length >= max) handles.delete(mine[0]?.handle ?? '')
    const handle = newHandle()
    handles.set(handle, {
      handle,
      accountId: held.accountId,
      platform,
      token,
      createdAt: server.now(),
    })
    server.reply(res, 201, { handle })
  }

  const ping: Handler = (req, res, _body, raw, [handle]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    if (raw.length > 0) {
      server.error(res, 400, 'bad-request')
      return
    }
    const held = handles.get(handle ?? '')
    if (!held || held.accountId !== auth.device.accountId) {
      server.error(res, 410, 'gone')
      return
    }
    const now = server.now()
    const recent = (pingTimes.get(held.handle) ?? []).filter((at) => now - at < HOUR_MS)
    const last = recent.at(-1)
    if (recent.length >= PINGS_PER_HOUR || (last !== undefined && now - last < PING_GAP_MS)) {
      pingTimes.set(held.handle, recent)
      server.error(res, 429, 'rate-limited', { 'Retry-After': '30' })
      return
    }
    pingTimes.set(held.handle, [...recent, now])
    if (invalidTokens.has(held.token)) {
      handles.delete(held.handle)
      server.error(res, 410, 'gone')
      return
    }
    pings.push({
      handle: held.handle,
      at: now,
      platform: held.platform,
      token: held.token,
      contentType: req.headers['content-type'],
    })
    res.writeHead(204).end()
  }

  const remove: Handler = (req, res, _body, _raw, [handle]) => {
    const auth = server.authed(req, res)
    if (!auth) return
    const held = handles.get(handle ?? '')
    if (!held || held.accountId !== auth.device.accountId) {
      server.error(res, 404, 'not-found')
      return
    }
    handles.delete(held.handle)
    deleted.push(held.handle)
    res.writeHead(204).end()
  }

  return [
    ['POST', /^\/v1\/push\/tickets$/, mint],
    ['POST', /^\/v1\/push\/register$/, register],
    ['POST', /^\/v1\/push\/([a-z2-7]+)$/, ping],
    ['DELETE', /^\/v1\/push\/([a-z2-7]+)$/, remove],
  ]
}
