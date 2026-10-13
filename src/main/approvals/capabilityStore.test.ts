import { describe, expect, it } from 'vitest'
import { dropIdentity, grant, hasCap, initCaps } from './capabilityStore'

describe('capabilityStore', () => {
  it('initCaps seeds the default capabilities and is idempotent', () => {
    const set = initCaps('ext-1')
    expect(set.has('drive-self')).toBe(true)
    expect(set.has('read-board')).toBe(true)
    expect(hasCap('ext-1', 'drive-self')).toBe(true)
    expect(hasCap('ext-1', 'read-board')).toBe(true)

    grant('ext-1', 'shell')
    const again = initCaps('ext-1')
    expect(again.has('shell')).toBe(true)
    expect(again).toBe(set)
  })

  it('grant adds an elevated cap and hasCap reflects it', () => {
    initCaps('ext-2')
    expect(hasCap('ext-2', 'shell')).toBe(false)
    grant('ext-2', 'shell')
    expect(hasCap('ext-2', 'shell')).toBe(true)
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
