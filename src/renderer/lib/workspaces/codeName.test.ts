import { describe, expect, it } from 'vitest'
import { codeName } from './codeName'

const sequence = (...values: number[]): (() => number) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

describe('codeName', () => {
  it('joins an adjective and a noun picked by the random source', () => {
    expect(codeName(new Set(), sequence(0, 0))).toBe('amber-acorn')
    expect(codeName(new Set(), sequence(0.999, 0.999))).toBe('zesty-yarrow')
  })

  it('draws again when the name is taken', () => {
    expect(codeName(new Set(['amber-acorn']), sequence(0, 0, 0.999, 0.999))).toBe('zesty-yarrow')
  })

  it('numbers a name when the random source only ever repeats a taken one', () => {
    expect(codeName(new Set(['amber-acorn']), () => 0)).toBe('amber-acorn-2')
    expect(codeName(new Set(['amber-acorn', 'amber-acorn-2']), () => 0)).toBe('amber-acorn-3')
  })
})
