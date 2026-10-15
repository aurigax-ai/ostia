import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const NONCE_PATTERN = /^[0-9a-f]{32}$/

export function markNonceFileFor(stateFile: string): string {
  return `${stateFile}.mark`
}

export function writeMarkNonce(file: string): string {
  const nonce = randomBytes(16).toString('hex')
  writeFileSync(file, nonce, { mode: 0o600 })
  return nonce
}

export function isMarkNonce(raw: unknown): raw is string {
  return typeof raw === 'string' && NONCE_PATTERN.test(raw)
}
