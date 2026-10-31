import { describe, expect, it } from 'vitest'
import { agyTurnStart, isAgyHookEvent } from './agyHook'

describe('agyTurnStart', () => {
  it('returns the conversation on the first model call of a turn', () => {
    expect(agyTurnStart(JSON.stringify({ conversationId: 'c-1', invocationNum: 0 }))).toBe('c-1')
  })

  it('returns nothing on a later model call of the same turn', () => {
    expect(agyTurnStart(JSON.stringify({ conversationId: 'c-1', invocationNum: 1 }))).toBeNull()
  })

  it('returns nothing for text that is not a hook payload or has no safe id', () => {
    expect(agyTurnStart('not json')).toBeNull()
    expect(agyTurnStart('[]')).toBeNull()
    expect(agyTurnStart(JSON.stringify({ conversationId: '../x', invocationNum: 0 }))).toBeNull()
  })

  it('knows only PreInvocation', () => {
    expect(isAgyHookEvent('PreInvocation')).toBe(true)
    expect(isAgyHookEvent('Stop')).toBe(false)
  })
})
