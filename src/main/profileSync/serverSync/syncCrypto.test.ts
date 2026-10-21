import { describe, expect, it } from 'vitest'
import vectors from '../../../../test/fixtures/server/vectors/sync.json'
import {
  generateDeviceKeys,
  keysFromSeeds,
  publicBytes,
  x25519FromSeed,
} from '../../server/deviceKeys'
import {
  blobId,
  contentHash,
  type Manifest,
  newProfileKey,
  openBlob,
  openDeviceWrap,
  openManifest,
  parseDeviceWrap,
  sealBlob,
  sealManifest,
  unwrapWithSecret,
  wrapForDevice,
  wrapSignedBy,
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
    const raw = JSON.parse(vectors.manifest) as Manifest
    const opened = openManifest(profileKey, b64(vectors.sealedManifest))
    expect(opened?.counter).toBe(7)
    expect(opened?.files).toEqual(raw.files)
    const sealed = sealManifest(profileKey, raw, b64(vectors.manifestNonce))
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

  it('SSY-C14 builds and opens the vector signed device wrap', () => {
    const signer = keysFromSeeds({
      sign: b64(vectors.wrapSignerSignSeed),
      box: b64(vectors.deviceBoxPrivateKey),
    })
    if (!signer) throw new Error('seeds')
    const wrap = wrapForDevice(
      profileKey,
      b64(vectors.deviceBoxPublicKey),
      vectors.wrapSlot,
      { id: vectors.wrapSignerId, signPrivate: signer.signPrivate },
      vectors.wrapCounter,
      x25519FromSeed(b64(vectors.ephemeralPrivateKey)),
      b64(vectors.deviceWrapNonce),
    )
    expect(wrap.toString('base64url')).toBe(vectors.deviceWrap)
    const box = x25519FromSeed(b64(vectors.deviceBoxPrivateKey))
    expect(publicBytes(box).toString('base64url')).toBe(vectors.deviceBoxPublicKey)
    const parsed = parseDeviceWrap(b64(vectors.deviceWrap))
    if (!parsed) throw new Error('parse')
    expect(parsed).toMatchObject({ signerId: vectors.wrapSignerId, counter: vectors.wrapCounter })
    expect(wrapSignedBy(parsed, vectors.wrapSlot, vectors.wrapSignerSignPub)).toBe(true)
    expect(wrapSignedBy(parsed, 'device:other', vectors.wrapSignerSignPub)).toBe(false)
    expect(openDeviceWrap(parsed, vectors.wrapSlot, box)?.equals(profileKey)).toBe(true)
    expect(openDeviceWrap(parsed, 'device:other', box)).toBeNull()
  })

  it('SSY-C17 rejects the vector wraps signed by the wrong key or altered after signing', () => {
    for (const blob of [vectors.wrongKeySignedWrap, vectors.tamperedWrap]) {
      const parsed = parseDeviceWrap(b64(blob))
      if (!parsed) throw new Error('parse')
      expect(wrapSignedBy(parsed, vectors.wrapSlot, vectors.wrapSignerSignPub)).toBe(false)
    }
    expect(parseDeviceWrap(b64(vectors.deviceWrap).subarray(1))).toBeNull()
    expect(
      parseDeviceWrap(Buffer.concat([Buffer.from([1]), b64(vectors.deviceWrap).subarray(1)])),
    ).toBeNull()
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

  it('SSY-C16 opens a device wrap only with the matching box key and slot', () => {
    const key = newProfileKey()
    const keys = generateDeviceKeys()
    const signer = { id: 'd1', signPrivate: generateDeviceKeys().signPrivate }
    const wrap = parseDeviceWrap(
      wrapForDevice(key, publicBytes(keys.boxPrivate), 'device:d2', signer, 3),
    )
    if (!wrap) throw new Error('parse')
    expect(openDeviceWrap(wrap, 'device:d2', keys.boxPrivate)?.equals(key)).toBe(true)
    expect(openDeviceWrap(wrap, 'device:d2', generateDeviceKeys().boxPrivate)).toBeNull()
    expect(openDeviceWrap(wrap, 'device:d3', keys.boxPrivate)).toBeNull()
  })
})
