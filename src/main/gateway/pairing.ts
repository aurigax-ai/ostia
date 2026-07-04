/**
 * Short-lived, single-use pairing codes for the LAN control gateway (Phase C batch 1,
 * `pine-companion/NETWORK-CONTRACT.md` §3). In-memory only, by design — a code only needs to
 * survive the ~2 minutes between "desktop shows a QR" and "phone finishes `POST /pair`"; an app
 * restart naturally invalidating any code nobody redeemed yet is the right behavior, not a bug.
 */
import { randomBytes } from 'node:crypto'

/** Contract §3.1: "~120s TTL, single-use." */
const CODE_TTL_MS = 120_000
/** No 0/O/1/I — avoids QR/typo ambiguity when a user reads the code aloud or types it. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

const codes = new Map<string, number>() // code -> expiry (epoch ms)

/** Drop any already-expired codes — opportunistic, keeps the map from growing unbounded. */
function sweepExpired(): void {
  const now = Date.now()
  for (const [code, expiry] of codes) {
    if (expiry < now) codes.delete(code)
  }
}

/** Mint a new pairing code: 8 chars, crypto-random, valid for 120s, single-use. */
export function newCode(): string {
  sweepExpired()
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  codes.set(code, Date.now() + CODE_TTL_MS)
  return code
}

/**
 * Redeem `code`: valid + unexpired -> `true`. Always single-use — the code is deleted whether
 * or not it was valid, so a wrong/expired guess can't be retried against the same slot.
 */
export function consumeCode(code: string): boolean {
  const expiry = codes.get(code)
  codes.delete(code)
  return expiry !== undefined && Date.now() <= expiry
}

/** Drop every pending code (tests only). */
export function resetCodes(): void {
  codes.clear()
}
