import { createHash } from 'node:crypto'

export interface DocumentFingerprint {
  size: number
  digest: string
}

const LINE_BREAK = 0x0a

function digestOf(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

export function fingerprintOf(body: Buffer): DocumentFingerprint | null {
  if (body.length === 0 || body[body.length - 1] !== LINE_BREAK) return null
  return { size: body.length, digest: digestOf(body) }
}

export function onlyAppended(before: DocumentFingerprint, body: Buffer): boolean {
  return body.length >= before.size && digestOf(body.subarray(0, before.size)) === before.digest
}
