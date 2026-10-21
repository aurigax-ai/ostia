import { describe, expect, it } from 'vitest'
import { registrationOf, generateDeviceKeys } from './deviceKeys'
import { createKeyStore, type KeyStoreDeps } from './keyStore'

function memory(canEncrypt = true): KeyStoreDeps & { saved: () => unknown } {
  let data: unknown = {}
  return {
    load: () => data,
    save: (next) => {
      data = next ?? {}
    },
    canEncrypt: () => canEncrypt,
    encrypt: (plain) => Buffer.from(plain).reverse().toString('base64'),
    decrypt: (secret) => Buffer.from(secret, 'base64').reverse().toString(),
    saved: () => data,
  }
}

describe('the device key store', () => {
  it('SVA-C5 stores seeds only encrypted and reads the same keys back', () => {
    const deps = memory()
    const store = createKeyStore(deps)
    const keys = generateDeviceKeys()
    expect(store.save(keys)).toBe(true)
    const plainSeed = Buffer.from(
      (keys.signPrivate.export({ format: 'jwk' }).d ?? '') as string,
      'base64url',
    ).toString('base64url')
    expect(JSON.stringify(deps.saved())).not.toContain(plainSeed)
    const loaded = store.load()
    expect(loaded && registrationOf(loaded)).toEqual(registrationOf(keys))
  })

  it('SVA-C6 saves and loads nothing when encryption is unavailable', () => {
    const store = createKeyStore(memory(false))
    expect(store.available()).toBe(false)
    expect(store.save(generateDeviceKeys())).toBe(false)
    expect(store.load()).toBeNull()
  })

  it('SVA-C7 forgets the keys on erase and ignores damaged data', () => {
    const deps = memory()
    const store = createKeyStore(deps)
    store.save(generateDeviceKeys())
    store.erase()
    expect(store.load()).toBeNull()
    deps.save({ sign: 'x', box: 'y' })
    expect(store.load()).toBeNull()
  })
})
