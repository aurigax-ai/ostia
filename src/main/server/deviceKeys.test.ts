import { describe, expect, it } from 'vitest'
import vectors from '../../../test/fixtures/server/auth.json'
import { generateDeviceKeys, keysFromSeeds, registrationOf, seedsOf, signChallenge } from './deviceKeys'

const BOX_SEED_START = 101
const BOX_SEED_BYTES = 32

function vectorKeys() {
  const box = Buffer.from(Array.from({ length: BOX_SEED_BYTES }, (_, i) => BOX_SEED_START + i))
  const keys = keysFromSeeds({ sign: Buffer.from(vectors.signSeed, 'base64url'), box })
  if (!keys) throw new Error('the vector seeds are valid')
  return keys
}

describe('device keys', () => {
  it('SVA-C1 derives the vector public keys and registration proof from the seeds', () => {
    const registration = registrationOf(vectorKeys())
    expect(registration.signPub).toBe(vectors.signPub)
    expect(registration.boxPub).toBe(vectors.boxPub)
    expect(registration.proof).toBe(vectors.registrationProof)
  })

  it('SVA-C2 signs the challenge exactly as the vector', () => {
    expect(signChallenge(vectorKeys(), vectors.deviceId, vectors.nonce)).toBe(
      vectors.challengeSignature,
    )
  })

  it('SVA-C3 keeps a generated pair across a seed round trip', () => {
    const keys = generateDeviceKeys()
    const again = keysFromSeeds(seedsOf(keys))
    expect(again).not.toBeNull()
    expect(registrationOf(again ?? keys)).toEqual(registrationOf(keys))
    expect(registrationOf(generateDeviceKeys()).signPub).not.toBe(registrationOf(keys).signPub)
  })

  it('SVA-C4 refuses a seed of the wrong length', () => {
    expect(keysFromSeeds({ sign: Buffer.alloc(31), box: Buffer.alloc(32) })).toBeNull()
    expect(keysFromSeeds({ sign: Buffer.alloc(32), box: Buffer.alloc(33) })).toBeNull()
  })
})
