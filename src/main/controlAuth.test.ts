import { describe, expect, it } from 'vitest'
import { grant } from './capabilityStore'
import { authenticate, connHasCap } from './controlAuth'
import { registerPane } from './idRegistry'

describe('controlAuth', () => {
  it('authenticates a valid token minted via registerPane', () => {
    const identity = registerPane({ windowId: 'w1', sessionId: 's1', paneId: 'p1' })
    const conn = authenticate({ token: identity.token })
    expect(conn).not.toBeNull()
    expect(conn?.externalId).toBe(identity.externalId)
    expect(conn?.paneId).toBe('p1')
    expect(conn?.sessionId).toBe('s1')
  })

  it('rejects an absent token', () => {
    expect(authenticate({})).toBeNull()
  })

  it('rejects a non-string token', () => {
    expect(authenticate({ token: 123 })).toBeNull()
  })

  it('rejects an unknown token', () => {
    expect(authenticate({ token: 'bogus' })).toBeNull()
  })

  it('connHasCap is true for a default cap and false for an ungranted elevated cap until granted', () => {
    const identity = registerPane({ windowId: 'w2', sessionId: 's2', paneId: 'p2' })
    const conn = authenticate({ token: identity.token })
    expect(conn).not.toBeNull()
    if (!conn) return
    expect(connHasCap(conn, 'read-board')).toBe(true)
    expect(connHasCap(conn, 'shell')).toBe(false)
    grant(conn.externalId, 'shell')
    expect(connHasCap(conn, 'shell')).toBe(true)
  })
})
