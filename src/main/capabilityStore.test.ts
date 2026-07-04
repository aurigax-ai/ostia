import { describe, expect, it } from 'vitest'
import { dropIdentity, grant, hasCap, initCaps, revoke } from './capabilityStore'

describe('capabilityStore', () => {
  it('initCaps seeds the default capabilities and is idempotent', () => {
    const set = initCaps('ext-1')
    expect(set.has('drive-self')).toBe(true)
    expect(set.has('read-board')).toBe(true)
    expect(hasCap('ext-1', 'drive-self')).toBe(true)
    expect(hasCap('ext-1', 'read-board')).toBe(true)

    // Idempotent: re-initializing doesn't reset a mutated set.
    grant('ext-1', 'shell')
    const again = initCaps('ext-1')
    expect(again.has('shell')).toBe(true)
    expect(again).toBe(set) // same underlying set instance
  })

  it('grant adds an elevated cap and hasCap reflects it', () => {
    initCaps('ext-2')
    expect(hasCap('ext-2', 'shell')).toBe(false)
    grant('ext-2', 'shell')
    expect(hasCap('ext-2', 'shell')).toBe(true)
  })

  it('revoke removes a granted cap', () => {
    initCaps('ext-3')
    grant('ext-3', 'shell')
    expect(hasCap('ext-3', 'shell')).toBe(true)
    revoke('ext-3', 'shell')
    expect(hasCap('ext-3', 'shell')).toBe(false)
  })

  it('hasCap is false for an ungranted elevated cap and for an unknown id', () => {
    initCaps('ext-4')
    expect(hasCap('ext-4', 'shell')).toBe(false)
    expect(hasCap('unknown-id', 'drive-self')).toBe(false)
  })

  it('dropIdentity clears all caps for an identity', () => {
    initCaps('ext-5')
    grant('ext-5', 'shell')
    expect(hasCap('ext-5', 'shell')).toBe(true)
    dropIdentity('ext-5')
    expect(hasCap('ext-5', 'shell')).toBe(false)
    expect(hasCap('ext-5', 'drive-self')).toBe(false)
  })
})
