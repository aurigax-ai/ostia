import { describe, expect, it } from 'vitest'
import vectors from '../../../../test/fixtures/server/vectors/sync.json'
import {
  blobId,
  contentHash,
  type Manifest,
  newProfileKey,
  openBlob,
  openManifest,
  sealBlob,
  sealManifest,
  unwrapWithSecret,
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
    expect(opened).toEqual(raw)
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
})
