import { describe, expect, it } from 'vitest'
import { accountOfTarget, DEFAULT_ACCOUNT, sessionIdOfArgs } from './claudeAccounts'

describe('sessionIdOfArgs', () => {
  it.each([
    [['--resume', 'abc-123'], 'abc-123'],
    [['--resume=abc-123'], 'abc-123'],
    [['-r', 'abc-123', '-p', 'hi'], 'abc-123'],
    [['--model', 'opus', '--resume', 'abc-123', '--fork-session'], 'abc-123'],
  ])('finds the session in %j', (args, id) => {
    expect(sessionIdOfArgs(args)).toBe(id)
  })

  it.each([
    [[]],
    [['--resume']],
    [['--resume', '--fork-session']],
    [['-p', 'hello']],
    [['--resume=']],
  ])('finds none in %j', (args) => {
    expect(sessionIdOfArgs(args)).toBeNull()
  })
})

describe('accountOfTarget', () => {
  const accounts = [
    { id: DEFAULT_ACCOUNT, email: null },
    { id: 'a'.repeat(16), email: 'Work@Example.com' },
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
