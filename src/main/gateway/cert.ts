import { X509Certificate, createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { generate } from 'selfsigned'

export interface GatewayCert {
  cert: string
  key: string
  fingerprint: string
}

const CERT_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000

function gatewayDir(baseDirOverride?: string): string {
  return baseDirOverride ?? join(app.getPath('userData'), 'gateway')
}

export function fingerprintOf(certPem: string): string {
  const der = new X509Certificate(certPem).raw
  return `sha256/${createHash('sha256').update(der).digest('base64')}`
}

let cached: GatewayCert | null = null

export async function getCert(baseDirOverride?: string): Promise<GatewayCert> {
  if (cached && !baseDirOverride) return cached

  const dir = gatewayDir(baseDirOverride)
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  let result: GatewayCert
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf8')
    const key = readFileSync(keyPath, 'utf8')
    chmodSync(certPath, 0o600)
    chmodSync(keyPath, 0o600)
    result = { cert, key, fingerprint: fingerprintOf(cert) }
  } else {
    const pems = await generate([{ name: 'commonName', value: 'ostia-gateway' }], {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + CERT_LIFETIME_MS),
    })
    writeFileSync(certPath, pems.cert, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(keyPath, pems.private, { encoding: 'utf8', mode: 0o600 })
    chmodSync(certPath, 0o600)
    chmodSync(keyPath, 0o600)
    result = { cert: pems.cert, key: pems.private, fingerprint: fingerprintOf(pems.cert) }
  }

  if (!baseDirOverride) cached = result
  return result
}

export function resetCertCache(): void {
  cached = null
}
