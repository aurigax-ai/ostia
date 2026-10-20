import { describe, expect, it } from 'vitest'
import { passes } from './evalCheck'

describe('passes', () => {
  it('matches and absent are each other’s opposite', () => {
    expect(passes({ kind: 'matches', value: 'function' }, 'a function')).toBe(true)
    expect(passes({ kind: 'matches', value: 'function' }, 'a class')).toBe(false)
    expect(passes({ kind: 'absent', value: '//' }, 'const a = 1')).toBe(true)
    expect(passes({ kind: 'absent', value: '//' }, 'a // b')).toBe(false)
  })

  it('stops a backtracking pattern and fails the check either way instead of hanging', () => {
    const output = `${'a'.repeat(40)}!`
    const started = Date.now()
    expect(passes({ kind: 'matches', value: '^(a+)+$' }, output)).toBe(false)
    expect(passes({ kind: 'absent', value: '^(a+)+$' }, output)).toBe(false)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('fails a pattern that does not compile and cuts a huge answer', () => {
    expect(passes({ kind: 'absent', value: '(' }, 'x')).toBe(false)
    expect(passes({ kind: 'matches', value: 'END' }, `${'x'.repeat(30_000)}END`)).toBe(false)
  })
})
