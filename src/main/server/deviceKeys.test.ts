import { describe, expect, it } from 'vitest'
import vectors from '../../../test/fixtures/server/vectors/auth.json'
import {
  digestOf,
  generateDeviceKeys,
  keysFromSeeds,
  registrationOf,
  seedsOf,
  signApprove,
  signChallenge,
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
    expect(signApprove(keys, 'dev-1', 'approval-1', 'dev-3')).toBe(
      'U9G2v-ujTM6dXWi5KkoIQBlqI-5s4kXkxyXsyhabwgFQ70yaaqx0imF7Xznhuy8UNGeeLanMnKSfPg6on9ImAg',
    )
  })

  it('SYA-C190 signs the stamped revoke and the manifest-bound clean-up exactly as the vectors', () => {
    const keys = vectorKeys()
    expect(vectors.revokeMessage).toBe(
      `ostia-server/revoke/v2\n${vectors.deviceId}\n${vectors.timestamp}\n${vectors.revokeTarget}`,
    )
    expect(
      signStamped(keys, 'revoke', vectors.deviceId, vectors.timestamp, [vectors.revokeTarget]),
    ).toBe(vectors.revokeSignature)
    expect(digestOf(vectors.syncGcBody)).toBe(vectors.syncGcBodyHash)
    expect(vectors.syncGcMessage).toBe(
      `ostia-server/sync-gc/v1\n${vectors.deviceId}\n${vectors.timestamp}\n${vectors.ifMatch}\n${vectors.syncGcBodyHash}`,
    )
    expect(
      signStamped(keys, 'syncGc', vectors.deviceId, vectors.timestamp, [
        String(vectors.ifMatch),
        vectors.syncGcBodyHash,
      ]),
    ).toBe(vectors.syncGcSignature)
  })

  it('SVA-C60 signs the slot-bound wrap read and the version and body-bound manifest push exactly as the vector', () => {
    const keys = vectorKeys()
    expect(vectors.wrapReadMessage).toBe(
      `ostia-server/wrap-read/v1\n${vectors.deviceId}\n${vectors.timestamp}\n${vectors.wrapSlot}`,
    )
    expect(
      signStamped(keys, 'wrapRead', vectors.deviceId, vectors.timestamp, [vectors.wrapSlot]),
    ).toBe(vectors.wrapReadSignature)
    expect(digestOf(vectors.manifestBody)).toBe(vectors.manifestBodyHash)
    expect(vectors.manifestPutMessage).toBe(
      `ostia-server/manifest-put/v1\n${vectors.deviceId}\n${vectors.timestamp}\n${vectors.ifMatch}\n${vectors.manifestBodyHash}`,
    )
    expect(
      signStamped(keys, 'manifestPut', vectors.deviceId, vectors.timestamp, [
        String(vectors.ifMatch),
        digestOf(vectors.manifestBody),
      ]),
    ).toBe(vectors.manifestPutSignature)
  })

  it('SVA-C61 signs a different message for another slot, version, body, device or time', () => {
    const keys = vectorKeys()
    const wrap = (id: string, stamp: number, slot: string) =>
      signStamped(keys, 'wrapRead', id, stamp, [slot])
    const put = (id: string, stamp: number, ifMatch: string, body: string) =>
      signStamped(keys, 'manifestPut', id, stamp, [ifMatch, digestOf(body)])
    const { deviceId, timestamp, manifestBody } = vectors
    expect(wrap(deviceId, timestamp, 'recovery')).not.toBe(vectors.wrapReadSignature)
    expect(wrap(deviceId, timestamp + 1, 'passphrase')).not.toBe(vectors.wrapReadSignature)
    expect(wrap('other', timestamp, 'passphrase')).not.toBe(vectors.wrapReadSignature)
    expect(put(deviceId, timestamp, '4', manifestBody)).not.toBe(vectors.manifestPutSignature)
    expect(put(deviceId, timestamp, '3', `${manifestBody} `)).not.toBe(vectors.manifestPutSignature)
    expect(put(deviceId, timestamp + 1, '3', manifestBody)).not.toBe(vectors.manifestPutSignature)
    expect(put('other', timestamp, '3', manifestBody)).not.toBe(vectors.manifestPutSignature)
    expect(put(deviceId, timestamp, '3', manifestBody)).not.toBe(vectors.wrapReadSignature)
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
