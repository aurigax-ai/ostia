import { describe, expect, it } from 'vitest'
import {
  deflated,
  rawZip,
  workbook,
  zeroBomb,
  zeros,
} from '../../../../test/fixtures/office/workbooks'
import { OFFICE_LIMITS } from './officeLimits'
import { checkZip, isZip } from './zipGuard'

const MIB = 1024 * 1024

function noise(bytes: number, seed: number): Uint8Array {
  const out = new Uint8Array(bytes)
  let state = seed
  for (let i = 0; i < bytes; i++) {
    state = (state * 1103515245 + 12345) >>> 0
    out[i] = 97 + ((state >>> 16) % 4)
  }
  return out
}

describe('checkZip', () => {
  it('passes a normal workbook', () => {
    const book = workbook({ Data: [['a', 1]] })
    expect(isZip(book)).toBe(true)
    expect(checkZip(book, OFFICE_LIMITS)).toBe('ok')
  })

  it('stops a zip bomb at the real inflated size, not its declared one', () => {
    expect(checkZip(zeroBomb(OFFICE_LIMITS.inflatedBytes + MIB), OFFICE_LIMITS)).toBe('unzip-limit')
    const lying = rawZip([zeros('xl/a.bin', 8 * MIB, 10)])
    expect(checkZip(lying, { ...OFFICE_LIMITS, inflatedBytes: 4 * MIB, entryRatio: 1e9 })).toBe(
      'unzip-limit',
    )
  })

  it('stops an entry whose expansion ratio passes the limit', () => {
    const ratio = rawZip([zeros('xl/a.bin', 4 * MIB)])
    expect(checkZip(ratio, OFFICE_LIMITS)).toBe('unzip-limit')
  })

  it('counts every directory entry, so entries sharing one body add up', () => {
    const body = deflated('xl/shared.xml', noise(MIB, 1))
    const overlapping = rawZip(
      [body],
      Array.from({ length: 10 }, () => 0),
    )
    expect(checkZip(overlapping, { ...OFFICE_LIMITS, inflatedBytes: 8 * MIB })).toBe('unzip-limit')
    expect(checkZip(rawZip([body]), { ...OFFICE_LIMITS, inflatedBytes: 8 * MIB })).toBe('ok')
  })

  it('refuses more entries than the limit', () => {
    const many = rawZip(
      Array.from({ length: 6 }, (_unused, i) => deflated(`f${i}.xml`, noise(10, i))),
    )
    expect(checkZip(many, { ...OFFICE_LIMITS, entries: 5 })).toBe('unzip-limit')
  })

  it('calls a truncated or damaged zip failed', () => {
    const book = workbook({ Data: [['a', 1]] })
    expect(checkZip(book.subarray(0, book.length - 30), OFFICE_LIMITS)).toBe('failed')
    const damaged = book.slice()
    damaged.fill(0, 30, 400)
    expect(checkZip(damaged, OFFICE_LIMITS)).toBe('failed')
  })
})
