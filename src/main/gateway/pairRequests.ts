import { randomBytes, randomUUID } from 'node:crypto'
import { deviceByInstallId, registerDevice } from './devices'
import { checkCode, commitOf } from './pairCheck'
import { auditPairAttempt, type PairVia } from './pairing'

export const PAIR_REQUEST_TTL_MS = 120_000
const NONCE_BYTES = 32

type PairReply = (status: number, body: unknown) => void

export interface PairRequestView {
  requestId: string
  name: string
  checkCode: string
  replaces: { name: string; lastSeenAt: string | null; caps: string[] } | null
}

interface PairRequest {
  name: string
  pubkey: string
  installId?: string
  commit: string
  peer: string
  via?: PairVia
  desktopNonce: Buffer
  timer: ReturnType<typeof setTimeout>
  waiting: { checkCode: string; reply: PairReply } | null
}

const requests = new Map<string, PairRequest>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) listener()
}

function end(requestId: string): PairRequest | null {
  const request = requests.get(requestId)
  if (!request) return null
  clearTimeout(request.timer)
  requests.delete(requestId)
  if (request.waiting) changed()
  return request
}

export function openPairRequest(input: {
  name: string
  pubkey: string
  installId?: string
  commit: string
  peer: string
  via?: PairVia
}): { requestId: string; desktopNonce: string } {
  const requestId = randomUUID()
  const desktopNonce = randomBytes(NONCE_BYTES)
  const timer = setTimeout(() => {
    end(requestId)?.waiting?.reply(408, { error: 'expired' })
  }, PAIR_REQUEST_TTL_MS)
  requests.set(requestId, { ...input, desktopNonce, timer, waiting: null })
  return { requestId, desktopNonce: desktopNonce.toString('base64') }
}

export function revealPairRequest(
  requestId: string,
  phoneNonce: string,
  fingerprint: string,
  reply: PairReply,
): 'ok' | 'unknown-request' | 'commit-mismatch' {
  const request = requests.get(requestId)
  if (!request || request.waiting) return 'unknown-request'
  const nonce = Buffer.from(phoneNonce, 'base64')
  if (nonce.length !== NONCE_BYTES || commitOf(nonce) !== request.commit) {
    end(requestId)
    return 'commit-mismatch'
  }
  request.waiting = {
    checkCode: checkCode(fingerprint, request.pubkey, nonce, request.desktopNonce),
    reply,
  }
  changed()
  return 'ok'
}

export function cancelPairRequest(requestId: string): void {
  end(requestId)
}

export interface PairAnswer {
  replaced: string[]
  replacedHandles: string[]
}

export function answerPairRequest(requestId: string, approve: boolean): PairAnswer | null {
  if (!requests.get(requestId)?.waiting) return null
  const request = end(requestId)
  const waiting = request?.waiting
  if (!request || !waiting) return null
  if (!approve) {
    waiting.reply(403, { error: 'declined' })
    return { replaced: [], replacedHandles: [] }
  }
  const { deviceId, token, caps, replaced, replacedHandles } = registerDevice({
    name: request.name,
    pubkey: request.pubkey,
    installId: request.installId,
  })
  auditPairAttempt(request.peer, 'ok', request.via)
  waiting.reply(200, { deviceId, deviceToken: token, caps, expiresAt: null })
  return { replaced, replacedHandles }
}

function replacesView(installId: string | undefined): PairRequestView['replaces'] {
  const device = deviceByInstallId(installId)
  if (!device) return null
  return { name: device.name, lastSeenAt: device.lastSeenAt ?? null, caps: device.caps }
}

export function listPairRequests(): PairRequestView[] {
  const views: PairRequestView[] = []
  for (const [requestId, request] of requests) {
    if (request.waiting) {
      views.push({
        requestId,
        name: request.name,
        checkCode: request.waiting.checkCode,
        replaces: replacesView(request.installId),
      })
    }
  }
  return views
}

export function onPairRequestsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetPairRequests(): void {
  for (const request of requests.values()) clearTimeout(request.timer)
  requests.clear()
}
