import { describe, expect, it } from 'vitest'
import { type ParkFacts, parkRefusal, singleLine } from './park'

const ok: ParkFacts = {
  manager: false,
  workspaceKind: 'terminal',
  sandboxed: false,
  remote: false,
  locked: false,
  agentRunning: true,
  hasResume: true,
  working: false,
}

describe('parkRefusal', () => {
  it('allows an idle agent with a session in a plain workspace', () => {
    expect(parkRefusal(ok)).toBeNull()
    expect(parkRefusal({ ...ok, workspaceKind: 'agent' })).toBeNull()
  })

  it.each([
    [{ manager: true }, 'manager'],
    [{ workspaceKind: 'manager' }, 'manager'],
    [{ workspaceKind: 'scratch' }, 'scratch'],
    [{ sandboxed: true }, 'sandboxed'],
    [{ remote: true }, 'remote'],
    [{ locked: true }, 'locked'],
    [{ agentRunning: false }, 'no-agent'],
    [{ hasResume: false }, 'no-session'],
    [{ working: true }, 'working'],
  ] as [Partial<ParkFacts>, string][])('refuses %o as %s', (over, reason) => {
    expect(parkRefusal({ ...ok, ...over })).toBe(reason)
  })

  it('names the manager before anything else', () => {
    expect(parkRefusal({ ...ok, manager: true, workspaceKind: 'scratch', working: true })).toBe(
      'manager',
    )
  })
})

describe('singleLine', () => {
  it('joins lines, drops control characters and cuts with an ellipsis', () => {
    expect(singleLine('a\nb\t c\u0000d', 20)).toBe('a b c d')
    expect(singleLine('x'.repeat(10), 5)).toBe('xxxx…')
    expect(singleLine('  ', 5)).toBe('')
  })
})
