import { describe, expect, it } from 'vitest'
import vectors from '../../../../test/fixtures/server/vectors/sync.json'
import { generateDeviceKeys, publicBytes, x25519FromSeed } from '../../server/deviceKeys'
import {
  blobId,
  contentHash,
  manifestJson,
  newProfileKey,
  openBlob,
  openManifest,
  sealBlob,
  sealManifest,
  unwrapForDevice,
  unwrapWithSecret,
  wrapForDevice,
  wrapWithSecret,
} from './syncCrypto'

const b64 = (text: string): Buffer => Buffer.from(text, 'base64url')
const profileKey = b64(vectors.profileKey)
const content = Buffer.from(vectors.content)

describe('sync crypto against the shared vectors', () => {
  it('SSY-C10 derives the blob id and content hash of the vector', () => {
    expect(contentHash(content)).toBe(vectors.contentHash)
    expect(blobId(profileKey, vectors.path, content)).toBe(vectors.blobId)
  })

  it('SSY-C11 seals and opens the vector blob byte for byte', () => {
    const sealed = sealBlob(profileKey, vectors.path, content, b64(vectors.blobNonce))
    expect(sealed.toString('base64url')).toBe(vectors.sealedBlob)
    expect(openBlob(profileKey, vectors.path, b64(vectors.sealedBlob))?.toString()).toBe(
      vectors.content,
    )
    expect(openBlob(profileKey, 'other.json', sealed)).toBeNull()
  })

  it('SSY-C12 seals and opens the vector manifest byte for byte', () => {
    const manifest = openManifest(profileKey, b64(vectors.sealedManifest))
    expect(manifest?.counter).toBe(7)
    expect(manifestJson(manifest ?? { counter: 0, files: {}, devices: [] })).toBe(vectors.manifest)
    const sealed = sealManifest(
      profileKey,
      manifest ?? { counter: 0, files: {}, devices: [] },
      b64(vectors.manifestNonce),
    )
    expect(sealed.toString('base64url')).toBe(vectors.sealedManifest)
    expect(openManifest(newProfileKey(), sealed)).toBeNull()
  })

  it('SSY-C13 builds and opens the vector passphrase wrap', async () => {
    const wrap = await wrapWithSecret(
      profileKey,
      vectors.passphrase,
      vectors.argon,
      b64(vectors.wrapSalt),
      b64(vectors.wrapNonce),
    )
    expect(wrap.toString('base64url')).toBe(vectors.passphraseWrap)
    expect(
      (await unwrapWithSecret(b64(vectors.passphraseWrap), vectors.passphrase))?.equals(profileKey),
    ).toBe(true)
    expect(await unwrapWithSecret(b64(vectors.passphraseWrap), 'wrong')).toBeNull()
  })

  it('SSY-C14 builds and opens the vector device wrap', () => {
    const wrap = wrapForDevice(
      profileKey,
      b64(vectors.deviceBoxPublicKey),
      x25519FromSeed(b64(vectors.ephemeralPrivateKey)),
      b64(vectors.deviceWrapNonce),
    )
    expect(wrap.toString('base64url')).toBe(vectors.deviceWrap)
    const box = x25519FromSeed(b64(vectors.deviceBoxPrivateKey))
    expect(publicBytes(box).toString('base64url')).toBe(vectors.deviceBoxPublicKey)
    expect(unwrapForDevice(b64(vectors.deviceWrap), box)?.equals(profileKey)).toBe(true)
  })
})

describe('sync crypto round trips', () => {
  it('SSY-C15 wraps with the production argon parameters and refuses bad parameters', async () => {
    const key = newProfileKey()
    const wrap = await wrapWithSecret(key, 'a passphrase')
    expect(wrap.readUInt32BE(1)).toBe(64 * 1024)
    expect([wrap[5], wrap[6]]).toEqual([3, 4])
    expect((await unwrapWithSecret(wrap, 'a passphrase'))?.equals(key)).toBe(true)
    const greedy = Buffer.from(wrap)
    greedy.writeUInt32BE(1024 * 1024, 1)
    expect(await unwrapWithSecret(greedy, 'a passphrase')).toBeNull()
    const costly = Buffer.from(wrap)
    costly.writeUInt32BE(64 * 1024 + 1, 1)
    expect(await unwrapWithSecret(costly, 'a passphrase')).toBeNull()
    for (const [at, value] of [
      [5, 4],
      [6, 5],
    ] as const) {
      const heavier = Buffer.from(wrap)
      heavier[at] = value
      expect(await unwrapWithSecret(heavier, 'a passphrase')).toBeNull()
    }
  })

  it('SSY-C16 opens a device wrap only with the matching box key', () => {
    const key = newProfileKey()
    const keys = generateDeviceKeys()
    const wrap = wrapForDevice(key, publicBytes(keys.boxPrivate))
    expect(unwrapForDevice(wrap, keys.boxPrivate)?.equals(key)).toBe(true)
    expect(unwrapForDevice(wrap, generateDeviceKeys().boxPrivate)).toBeNull()
  })
})
