import { describe, expect, it } from 'vitest'
import { lineReference } from './fileReference'

describe('lineReference', () => {
  it('names one line or a line span', () => {
    expect(lineReference('/a/b.ts', 3, 3)).toBe('/a/b.ts:3')
    expect(lineReference('/a/b.ts', 3, 9)).toBe('/a/b.ts:3-9')
  })
})
