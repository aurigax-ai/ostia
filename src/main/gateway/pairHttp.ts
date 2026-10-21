import type { IncomingMessage, ServerResponse } from 'node:http'
import { cleanDeviceName } from '../../shared/gateway/deviceName'
import {
  auditPairAttempt,
  checkPairRateLimit,
  consumeCode,
  isLiveCode,
  type PairVia,
} from './pairing'
import { cancelPairRequest, openPairRequest, revealPairRequest } from './pairRequests'

export interface PairHttpDeps {
  peerAddress: (socket: object & { remoteAddress?: string }) => string
  via: (socket: object) => PairVia | undefined
  accepted: (socket: object) => void
  fingerprint: () => string | null
  isAllowedHostHeader: (hostHeader: string | undefined) => boolean
  hasBrowserOrigin: (origin: string | undefined) => boolean
}

function readJsonBody(req: IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

const COMMIT = /^[0-9a-f]{64}$/
const INSTALL_ID = /^[A-Za-z0-9_-]{16,64}$/

async function handlePair(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PairHttpDeps,
): Promise<void> {
  const ip = deps.peerAddress(req.socket)
  const via = deps.via(req.socket)
  if (!checkPairRateLimit(ip)) {
    auditPairAttempt(ip, 'rate-limited', via)
    sendJson(res, 429, { error: 'rate-limited' })
    return
  }
  const body = (await readJsonBody(req)) as {
    pairCode?: unknown
    device?: { name?: unknown; pubkey?: unknown; installId?: unknown }
    commit?: unknown
  } | null
  const pairCode = body?.pairCode
  const device = body?.device
  if (
    typeof pairCode !== 'string' ||
    !device ||
    cleanDeviceName(device.name) === null ||
    typeof device.pubkey !== 'string' ||
    (device.installId !== undefined &&
      (typeof device.installId !== 'string' || !INSTALL_ID.test(device.installId)))
  ) {
    auditPairAttempt(ip, 'bad-request', via)
    sendJson(res, 400, {
      error: 'bad-request',
      message: 'expected { pairCode, device: { name, pubkey, installId? }, commit }',
    })
    return
  }
  if (!isLiveCode(pairCode)) {
    auditPairAttempt(ip, 'invalid-code', via)
    sendJson(res, 401, { error: 'invalid-pair-code' })
    return
  }
  if (typeof body?.commit !== 'string' || !COMMIT.test(body.commit)) {
    auditPairAttempt(ip, 'bad-request', via)
    sendJson(res, 400, { error: 'bad-request', message: 'commit must be 64 hex characters' })
    return
  }
  deps.accepted(req.socket)
  consumeCode(pairCode)
  const { requestId, desktopNonce } = openPairRequest({
    name: cleanDeviceName(device.name) ?? '',
    pubkey: device.pubkey,
    installId: device.installId as string | undefined,
    commit: body.commit,
    peer: ip,
    via,
  })
  sendJson(res, 200, { requestId, nonce: desktopNonce })
}

async function handlePairConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PairHttpDeps,
): Promise<void> {
  const body = (await readJsonBody(req)) as { requestId?: unknown; nonce?: unknown } | null
  if (typeof body?.requestId !== 'string' || typeof body.nonce !== 'string') {
    sendJson(res, 400, { error: 'bad-request', message: 'expected { requestId, nonce }' })
    return
  }
  const requestId = body.requestId
  const outcome = revealPairRequest(
    requestId,
    body.nonce,
    deps.fingerprint() ?? '',
    (status, reply) => sendJson(res, status, reply),
  )
  if (outcome === 'ok') deps.accepted(req.socket)
  if (outcome === 'unknown-request') {
    sendJson(res, 404, { error: 'unknown-request' })
    return
  }
  if (outcome === 'commit-mismatch') {
    sendJson(res, 400, { error: 'commit-mismatch' })
    return
  }
  res.on('close', () => {
    if (!res.writableEnded) cancelPairRequest(requestId)
  })
}

function requestHandler(req: IncomingMessage, res: ServerResponse, deps: PairHttpDeps): void {
  if (deps.hasBrowserOrigin(req.headers.origin)) {
    sendJson(res, 403, { error: 'origin-not-allowed' })
    return
  }
  if (!deps.isAllowedHostHeader(req.headers.host)) {
    sendJson(res, 403, { error: 'host-not-allowed' })
    return
  }
  if (req.method === 'POST' && req.url === '/pair') {
    handlePair(req, res, deps).catch(() => sendJson(res, 500, { error: 'internal-error' }))
    return
  }
  if (req.method === 'POST' && req.url === '/pair/confirm') {
    handlePairConfirm(req, res, deps).catch(() => sendJson(res, 500, { error: 'internal-error' }))
    return
  }
  sendJson(res, 404, { error: 'not-found' })
}

export function createPairHttp(deps: PairHttpDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => requestHandler(req, res, deps)
}
