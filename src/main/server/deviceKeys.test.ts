import { describe, expect, it } from 'vitest'
import vectors from '../../../test/fixtures/server/auth.json'
import {
  generateDeviceKeys,
  keysFromSeeds,
  registrationOf,
  seedsOf,
  signApprove,
  signChallenge,
  signRevoke,
  signSeen,
  signStamped,
} from './deviceKeys'

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

  it('SSY-C5 signs the invite, elevation, revoke, approve and seen messages like the Go reference', () => {
    const keys = vectorKeys()
    const stamp = 1_700_000_000_000
    expect(signStamped(keys, 'invite', 'dev-1', stamp)).toBe(
      '_jGFCG04Bmi2bafTgYEAPlY7Ec1k3lrwWIuGD_lMQp6Cs_E5J3pMCfxGVvjNkaZV0vKncIPXsWHpXUKInCXjDA',
    )
    expect(signStamped(keys, 'elevate', 'dev-1', stamp)).toBe(
      '_ctgJmpYSbzz6JDdTDHzrUawUzukamSbzhqGowEKIWv1FK8c6ZWNL8LN7q5hsyhXxhp0V65CSPRM2G_zz_FhDQ',
    )
    expect(signRevoke(keys, 'dev-1', 'dev-2')).toBe(
      'uIo_7LVGcPsAwnX8n-LO-rAKtyrw9CAYrfqWCnRok11ZEvDn2W6qKaeszI7ClORQ7qecOgWSiasgeu2FWiAHDQ',
    )
    expect(signApprove(keys, 'dev-1', 'approval-1', 'dev-3')).toBe(
      'U9G2v-ujTM6dXWi5KkoIQBlqI-5s4kXkxyXsyhabwgFQ70yaaqx0imF7Xznhuy8UNGeeLanMnKSfPg6on9ImAg',
    )
    expect(signSeen(keys, 'dev-1', 'dev-4')).toBe(
      'ot1FNAJBDyMc71f1W4rFugE0BuHZ42Rogpi3BK4tpb0lKRYlo8LuvsJ9YLSnhA4v_PnygOsoI_JjQUMgxRAaAg',
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
