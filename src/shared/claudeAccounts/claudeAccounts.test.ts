import { describe, expect, it } from 'vitest'
import { accountOfTarget, DEFAULT_ACCOUNT } from './claudeAccounts'

describe('accountOfTarget', () => {
  const accounts = [
    { id: DEFAULT_ACCOUNT, email: null, signedOut: false, enabled: true, usage: null },
    { id: 'a'.repeat(16), email: 'Work@Example.com', signedOut: false, enabled: true, usage: null },
  ]

  it('picks by 1-based number', () => {
    expect(accountOfTarget(accounts, '1')?.id).toBe(DEFAULT_ACCOUNT)
    expect(accountOfTarget(accounts, '2')?.email).toBe('Work@Example.com')
  })

  it('picks by email, ignoring case', () => {
    expect(accountOfTarget(accounts, 'work@example.com')?.id).toBe('a'.repeat(16))
  })

  it('answers null for an unknown number or email', () => {
    expect(accountOfTarget(accounts, '3')).toBeNull()
    expect(accountOfTarget(accounts, '0')).toBeNull()
    expect(accountOfTarget(accounts, 'nobody@example.com')).toBeNull()
  })
})
