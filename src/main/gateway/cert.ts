/**
 * Self-signed TLS cert for the LAN control gateway (Phase C batch 1,
 * `pine-companion/NETWORK-CONTRACT.md` §2/§3). Generated once via `selfsigned` and persisted
 * under `app.getPath('userData')/gateway/` (`cert.pem` + `key.pem`) — reused across restarts,
 * NOT regenerated per-launch, because every paired phone has already pinned this cert's
 * fingerprint via TOFU (contract §3, §8.1: "refuse a changed cert"); rotating it silently would
 * strand every paired device.
 *
 * `fingerprint` is computed independently of `selfsigned`'s own (SHA-1, colon-hex) `fingerprint`
 * field: `sha256/<base64 of the DER cert's SHA-256>` via `node:crypto`, matching the format the
 * QR payload advertises and the phone pins (contract §3.2).
 */
import { X509Certificate, createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { generate } from 'selfsigned'

export interface GatewayCert {
  cert: string
  key: string
  /** `sha256/<base64>` of the DER cert's SHA-256 — pinned by the phone at pairing (TOFU). */
  fingerprint: string
}

/** ~10 years — long enough that a device paired once never needs a re-pin from expiry alone. */
const CERT_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000

/** Directory the cert/key persist under: `<userData>/gateway/` (or `baseDirOverride`, tests only). */
function gatewayDir(baseDirOverride?: string): string {
  return baseDirOverride ?? join(app.getPath('userData'), 'gateway')
}

/** `sha256/<base64>` of the DER-encoded cert's SHA-256 — the value the phone pins at pairing. */
export function fingerprintOf(certPem: string): string {
  const der = new X509Certificate(certPem).raw
  return `sha256/${createHash('sha256').update(der).digest('base64')}`
}

/** In-memory cache so repeated `getCert()` calls (e.g. every `gateway.status`) don't re-read disk. */
let cached: GatewayCert | null = null

/**
 * Load the persisted cert/key if present, else generate a new self-signed cert and persist it.
 * `baseDirOverride` (tests only) skips the in-memory cache so each test gets its own directory.
 */
export async function getCert(baseDirOverride?: string): Promise<GatewayCert> {
  if (cached && !baseDirOverride) return cached

  const dir = gatewayDir(baseDirOverride)
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')

  // Owner-only, always — the private key (and, for consistency, the cert alongside it) must
  // never be world/group-readable, else any other local user on the machine can read the key
  // and impersonate the gateway (security review finding). `mkdirSync`'s `mode` only takes
  // effect when the dir is actually CREATED, so a pre-fix (pre-existing, possibly-world-
  // readable) `gateway/` dir needs the explicit `chmodSync` below too.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  let result: GatewayCert
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf8')
    const key = readFileSync(keyPath, 'utf8')
    // Same belt-and-suspenders as the dir: a cert/key pair written before this fix shipped may
    // still be world-readable on disk — reassert 0600 on every load, not just on first write.
    chmodSync(certPath, 0o600)
    chmodSync(keyPath, 0o600)
    result = { cert, key, fingerprint: fingerprintOf(cert) }
  } else {
    const pems = await generate([{ name: 'commonName', value: 'pine-gateway' }], {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + CERT_LIFETIME_MS),
    })
    writeFileSync(certPath, pems.cert, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(keyPath, pems.private, { encoding: 'utf8', mode: 0o600 })
    // `mode` on `writeFileSync` only applies when the file doesn't already exist (a stale
    // leftover from a crashed prior run would otherwise keep its old mode) — chmod explicitly.
    chmodSync(certPath, 0o600)
    chmodSync(keyPath, 0o600)
    result = { cert: pems.cert, key: pems.private, fingerprint: fingerprintOf(pems.cert) }
  }

  if (!baseDirOverride) cached = result
  return result
}

/** Drop the in-memory cache (tests only) so the next `getCert()` re-reads/regenerates. */
export function resetCertCache(): void {
  cached = null
}
