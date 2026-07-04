/**
 * Short-lived, single-use pairing codes for the LAN control gateway (Phase C batch 1,
 * `pine-companion/NETWORK-CONTRACT.md` §3). In-memory only, by design — a code only needs to
 * survive the ~2 minutes between "desktop shows a QR" and "phone finishes `POST /pair`"; an app
 * restart naturally invalidating any code nobody redeemed yet is the right behavior, not a bug.
 *
 * Also holds `/pair`'s per-source-IP rate limit + audit log (security review, minor finding):
 * `POST /pair` is the one plain-HTTP endpoint this whole surface exposes, so it's the natural
 * target for a brute-force pairCode guesser — throttling is in-memory (same "restart clears it"
 * posture as the codes above), the audit log is durable (best-effort append, `~/.local/share/
 * pine/gateway-pair-audit.log`) so a device owner can see who's been knocking even after a
 * restart.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

/** ≤5 pairing attempts per source IP per rolling 60s window. */
const PAIR_RATE_LIMIT_WINDOW_MS = 60_000
const PAIR_RATE_LIMIT_MAX = 5
const pairAttemptsByIp = new Map<string, number[]>() // ip -> timestamps within the current window

/**
 * Throttle `POST /pair`: returns `false` (caller should reply 429) once `ip` has made
 * `PAIR_RATE_LIMIT_MAX` attempts within the last `PAIR_RATE_LIMIT_WINDOW_MS` — a bounded
 * in-memory sliding window (mirrors `codes`' "restart clears state" posture; this isn't a
 * durability guarantee, just a brute-force speed bump). A rejected attempt still occupies a
 * slot (it counts as an attempt), so a caller can't dodge the window by spamming past the cap.
 */
export function checkPairRateLimit(ip: string): boolean {
  const now = Date.now()
  const recent = (pairAttemptsByIp.get(ip) ?? []).filter((t) => now - t < PAIR_RATE_LIMIT_WINDOW_MS)
  recent.push(now)
  pairAttemptsByIp.set(ip, recent)
  return recent.length <= PAIR_RATE_LIMIT_MAX
}

/** Drop every rate-limit counter (tests only). */
export function resetPairRateLimit(): void {
  pairAttemptsByIp.clear()
}

function pairAuditLogPath(): string {
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'pine',
    'gateway-pair-audit.log',
  )
}

/**
 * Append one line to the pairing audit log — best-effort (a logging failure must never break
 * pairing itself, so any `fs` error here is swallowed). Newline-delimited JSON, one attempt per
 * line, so it's both human-`tail`-able and machine-parseable.
 */
export function auditPairAttempt(
  ip: string,
  outcome: 'ok' | 'invalid-code' | 'bad-request' | 'rate-limited',
): void {
  try {
    const path = pairAuditLogPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(
      path,
      `${JSON.stringify({ ts: new Date().toISOString(), ip, outcome })}\n`,
      'utf8',
    )
  } catch {
    // best-effort audit trail — never let a logging failure break pairing
  }
}
