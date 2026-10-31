import { describe, expect, it } from 'vitest'
import { fingerprintOf, onlyAppended } from './viewerAppend'

const text = (value: string): Buffer => Buffer.from(value)

describe('fingerprintOf', () => {
  it('describes only a document that ends on a line break', () => {
    expect(fingerprintOf(text('a,b\n1,2\n'))).toMatchObject({ size: 8 })
    expect(fingerprintOf(text('a,b\n1,2'))).toBeNull()
    expect(fingerprintOf(text(''))).toBeNull()
  })
})

describe('onlyAppended', () => {
  const before = fingerprintOf(text('a,b\n1,2\n3,4\n'))
  if (!before) throw new Error('no fingerprint')

  it('accepts a file that kept every old byte and grew at the end', () => {
    expect(onlyAppended(before, text('a,b\n1,2\n3,4\n5,6\n'))).toBe(true)
    expect(onlyAppended(before, text('a,b\n1,2\n3,4\n'))).toBe(true)
  })

  it('refuses a file whose old bytes changed, whatever its size', () => {
    expect(onlyAppended(before, text('a,b\n1,9\n3,4\n5,6\n'))).toBe(false)
    expect(onlyAppended(before, text('a,b\n1,2\n3,5\n'))).toBe(false)
  })

  it('refuses a file that got shorter', () => {
    expect(onlyAppended(before, text('a,b\n1,2\n'))).toBe(false)
  })
})
