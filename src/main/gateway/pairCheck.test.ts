import { describe, expect, it } from 'vitest'
import { checkCode } from './pairCheck'

const FINGERPRINT = 'sha256/q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA='
const PUBKEY = 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE='
const PHONE_NONCE = Buffer.alloc(32, 1)
const DESKTOP_NONCE = Buffer.alloc(32, 2)

describe('gateway/pairCheck', () => {
  it('CPD-C18 computes the contract test vector', () => {
    expect(checkCode(FINGERPRINT, PUBKEY, PHONE_NONCE, DESKTOP_NONCE)).toBe('396848')
  })

  it('CPD-C16 gives a relay holding another certificate different digits', () => {
    const relay = 'sha256/OTHERfingerprintOTHERfingerprintOTHERfing='
    const phoneSees = checkCode(relay, PUBKEY, PHONE_NONCE, DESKTOP_NONCE)
    const desktopShows = checkCode(FINGERPRINT, PUBKEY, PHONE_NONCE, DESKTOP_NONCE)
    expect(phoneSees).toBe('274033')
    expect(phoneSees).not.toBe(desktopShows)
  })
})
