import { createPublicKey, verify } from 'node:crypto'

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

export function verifyEd25519(
  signPub: string,
  message: string | Buffer,
  signature: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(signPub, 'base64url')]),
      format: 'der',
      type: 'spki',
    })
    return verify(
      null,
      typeof message === 'string' ? Buffer.from(message, 'utf8') : message,
      key,
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    return false
  }
}
