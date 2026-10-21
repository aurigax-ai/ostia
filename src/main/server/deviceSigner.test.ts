import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateDeviceKeys, registrationOf } from './deviceKeys'
import { DeviceSigner } from './deviceSigner'

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

function setup(now = () => 1_700_000_000_000) {
  const keys = generateDeviceKeys()
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519, Buffer.from(registrationOf(keys).signPub, 'base64url')]),
    format: 'der',
    type: 'spki',
  })
  const signer = new DeviceSigner({ keys: () => keys, deviceId: () => 'dev-1', now })
  const valid = (message: string, signature: string): boolean =>
    verify(null, Buffer.from(message), publicKey, Buffer.from(signature, 'base64url'))
  return { signer, valid }
}

describe('device signatures', () => {
  it('SSY-C1 signs the invite and elevation messages with a timestamp header', () => {
    const { signer, valid } = setup()
    const invite = signer.stamped('invite')
    expect(invite['X-Device-Timestamp']).toBe('1700000000000')
    expect(
      valid('ostia-server/invite/v1\ndev-1\n1700000000000', invite['X-Device-Signature']),
    ).toBe(true)
    const elevate = signer.stamped('elevate')
    expect(elevate['X-Device-Timestamp']).toBe('1700000000001')
    expect(
      valid('ostia-server/elevate/v1\ndev-1\n1700000000001', elevate['X-Device-Signature']),
    ).toBe(true)
  })

  it('SSY-C2 keeps timestamps strictly increasing when the clock does not move', () => {
    const { signer } = setup()
    const stamps = [1, 2, 3].map((_) => Number(signer.stamped('invite')['X-Device-Timestamp']))
    expect(stamps).toEqual([1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002])
  })

  it('SSY-C3 signs revoke, approve and seen over the exact messages', () => {
    const { signer, valid } = setup()
    expect(
      valid('ostia-server/revoke/v1\ndev-1\ndev-2', signer.revoke('dev-2')['X-Device-Signature']),
    ).toBe(true)
    expect(
      valid(
        'ostia-server/approve/v1\ndev-1\napproval-9\ndev-3',
        signer.approve('approval-9', 'dev-3')['X-Device-Signature'],
      ),
    ).toBe(true)
    expect(valid('ostia-server/seen/v1\ndev-1\ndev-4', signer.seen('dev-4'))).toBe(true)
    expect(valid('ostia-server/seen/v1\ndev-1\ndev-5', signer.seen('dev-4'))).toBe(false)
  })

  it('SSY-C4 refuses to sign when signed out', () => {
    const signer = new DeviceSigner({ keys: () => null, deviceId: () => null })
    expect(() => signer.revoke('x')).toThrow(/not-signed-in/)
  })
})
