import { createHash } from 'node:crypto'

const SEPARATOR = Buffer.from([0])
const DIGITS = 1_000_000

export function checkCode(
  fingerprint: string,
  pubkey: string,
  phoneNonce: Buffer,
  desktopNonce: Buffer,
): string {
  const digest = createHash('sha256')
    .update(Buffer.from(fingerprint, 'utf8'))
    .update(SEPARATOR)
    .update(Buffer.from(pubkey, 'utf8'))
    .update(SEPARATOR)
    .update(phoneNonce)
    .update(desktopNonce)
    .digest()
  return String(digest.readUInt32BE(0) % DIGITS).padStart(6, '0')
}

export function commitOf(nonce: Buffer): string {
  return createHash('sha256').update(nonce).digest('hex')
}
