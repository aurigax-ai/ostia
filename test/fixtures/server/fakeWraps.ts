import { verifyEd25519 } from './fakeCrypto'
import type { FakeDevice, FakeServer } from './fakeServer'

const SIGNATURE_CONTEXT = 'ostia-sync/wrap/sig/v1\n'
const VERSION = 2
const FIXED_AFTER_ID = 8 + 32 + 12 + 48
const SIGNATURE_BYTES = 64

export type WrapVerdict = 'ok' | 'bad-wrap' | 'wrong-signer'

export function checkDeviceWrap(
  server: FakeServer,
  signer: FakeDevice,
  slot: string,
  blob: string,
): WrapVerdict {
  const bytes = Buffer.from(blob, 'base64url')
  if (bytes.length < 2 || bytes[0] !== VERSION) return 'bad-wrap'
  const idLength = bytes[1] ?? 0
  const signedLength = 2 + idLength + FIXED_AFTER_ID
  if (idLength === 0 || bytes.length !== signedLength + SIGNATURE_BYTES) return 'bad-wrap'
  const signerId = bytes.subarray(2, 2 + idLength).toString('utf8')
  const active = server.devices.get(signerId)
  if (signerId !== signer.id || !active) return 'wrong-signer'
  const message = Buffer.concat([
    Buffer.from(`${SIGNATURE_CONTEXT}${slot}\n`),
    bytes.subarray(0, signedLength),
  ])
  return verifyEd25519(active.signPub, message, bytes.subarray(signedLength).toString('base64url'))
    ? 'ok'
    : 'bad-wrap'
}
