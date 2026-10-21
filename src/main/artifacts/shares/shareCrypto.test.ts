import { describe, expect, it } from 'vitest'
import vectors from '../../../../test/fixtures/server/vectors/share.json'
import {
  decryptShare,
  deriveShareKey,
  encryptShare,
  newFragmentKey,
  newSalt,
  SHARE_OVERHEAD,
  shareLink,
} from './shareCrypto'

const FIXED_NONCE = Buffer.alloc(12, 7)

interface Vector {
  name: string
  id: string
  mode: string
  fragmentKey?: string
  password?: string
  salt?: string
  nonce: string
  plaintext: string
  derivedKey: string
  blob: string
}

describe('share crypto against the server vectors', () => {
  for (const vector of vectors.cases as Vector[]) {
    const fragment = vector.fragmentKey ? Buffer.from(vector.fragmentKey, 'base64url') : undefined
    const salt = vector.salt ? Buffer.from(vector.salt, 'base64url') : undefined
    const { password } = vector
    const mode = vector.mode === 'link' ? 'link' : 'password'

    it(`SHR-C0 derives the vector key and the vector blob for ${vector.name}`, async () => {
      const key = await deriveShareKey({ mode, password, salt, fragment })
      expect(key.toString('base64url')).toBe(vector.derivedKey)
      const blob = encryptShare(
        vector.id,
        key,
        Buffer.from(vector.plaintext),
        Buffer.from(vector.nonce, 'base64url'),
      )
      expect(blob.toString('base64url')).toBe(vector.blob)
    })

    it(`SHR-C1 opens the vector blob for ${vector.name}`, () => {
      const plain = decryptShare(
        vector.id,
        Buffer.from(vector.derivedKey, 'base64url'),
        Buffer.from(vector.blob, 'base64url'),
      )
      expect(plain.toString('utf8')).toBe(vector.plaintext)
    })
  }
})

describe('share crypto', () => {
  it('SHR-C2 declares len(plaintext)+29 as the blob size', () => {
    const plain = Buffer.from('héllo')
    const blob = encryptShare('abc', newFragmentKey(), plain)
    expect(SHARE_OVERHEAD).toBe(29)
    expect(blob.length).toBe(plain.length + 29)
  })

  it('SHR-C3 refuses a blob opened under another share id or key', () => {
    const key = newFragmentKey()
    const blob = encryptShare('one', key, Buffer.from('x'), FIXED_NONCE)
    expect(() => decryptShare('two', key, blob)).toThrow()
    expect(() => decryptShare('one', newFragmentKey(), blob)).toThrow()
    expect(() => decryptShare('one', key, Buffer.from([2, ...blob.subarray(1)]))).toThrow()
  })

  it('SHR-C4 needs a key for link shares and a password and salt for password shares', async () => {
    await expect(deriveShareKey({ mode: 'link' })).rejects.toThrow()
    await expect(deriveShareKey({ mode: 'password', password: 'p' })).rejects.toThrow()
    expect(newSalt().length).toBe(16)
  })

  it('SHR-C5 puts the key in the fragment only when there is one', () => {
    const key = Buffer.alloc(32, 1)
    expect(shareLink('https://a.example/', key)).toBe(
      `https://a.example/#k=${key.toString('base64url')}`,
    )
    expect(shareLink('https://a.example/', null)).toBe('https://a.example/')
  })
})
