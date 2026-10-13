import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appDataDir } from '../platform/userDirs'

export { formatCode } from '../../shared/gateway/pairCode'

const CODE_TTL_MS = 120_000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

const codes = new Map<string, number>()
const codeListeners = new Set<() => void>()

function codesChanged(): void {
  for (const listener of codeListeners) listener()
}

export function onCodesChanged(listener: () => void): () => void {
  codeListeners.add(listener)
  return () => codeListeners.delete(listener)
}

export function liveCodeCount(): number {
  sweepExpired()
  return codes.size
}

function sweepExpired(): void {
  const now = Date.now()
  for (const [code, expiry] of codes) {
    if (expiry < now) codes.delete(code)
  }
}

export function newCode(): string {
  sweepExpired()
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  codes.set(code, Date.now() + CODE_TTL_MS)
  setTimeout(codesChanged, CODE_TTL_MS + 1).unref?.()
  codesChanged()
  return code
}

export function isLiveCode(code: string): boolean {
  const expiry = codes.get(code)
  return expiry !== undefined && Date.now() <= expiry
}

export function consumeCode(code: string): boolean {
  const expiry = codes.get(code)
  codes.delete(code)
  if (expiry !== undefined) codesChanged()
  return expiry !== undefined && Date.now() <= expiry
}

export function resetCodes(): void {
  codes.clear()
}

const PAIR_RATE_LIMIT_WINDOW_MS = 60_000
const PAIR_RATE_LIMIT_MAX = 5
const pairAttemptsByIp = new Map<string, number[]>()

export function checkPairRateLimit(ip: string): boolean {
  const now = Date.now()
  const recent = (pairAttemptsByIp.get(ip) ?? []).filter((t) => now - t < PAIR_RATE_LIMIT_WINDOW_MS)
  recent.push(now)
  pairAttemptsByIp.set(ip, recent)
  return recent.length <= PAIR_RATE_LIMIT_MAX
}

export function resetPairRateLimit(): void {
  pairAttemptsByIp.clear()
}

export function pairAuditLogPath(): string {
  return join(appDataDir(), 'gateway-pair-audit.log')
}

function isLocalPeer(ip: string): boolean {
  return ip.startsWith('127.') || ip.startsWith('::ffff:127.') || ip === '::1'
}

export function auditPairAttempt(
  ip: string,
  outcome: 'ok' | 'invalid-code' | 'bad-request' | 'rate-limited',
): void {
  try {
    const path = pairAuditLogPath()
    mkdirSync(dirname(path), { recursive: true })
    const via = isLocalPeer(ip) ? { via: 'this-computer' } : {}
    appendFileSync(
      path,
      `${JSON.stringify({ ts: new Date().toISOString(), ip, outcome, ...via })}\n`,
      'utf8',
    )
  } catch {}
}
