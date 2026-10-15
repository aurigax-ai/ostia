import { describe, expect, it } from 'vitest'
import { probeSheetJS } from '../../../test/fixtures/office/sheetjsProbe'
import {
  declaredSizeBomb,
  deflated,
  hiddenDirectoryBomb,
  rawZip,
  workbook,
  zeroBomb,
  zeros,
} from '../../../test/fixtures/office/workbooks'
import { checkCanonicalZip, isZip } from './canonicalZip'
import { GuardStop, OFFICE_LIMITS, type OfficeLimits, type OfficeProblem } from './officeLimits'

const MIB = 1024 * 1024
const SMALL: OfficeLimits = { ...OFFICE_LIMITS, inflatedBytes: 32 * MIB }

function verdict(bytes: Uint8Array, limits: OfficeLimits = OFFICE_LIMITS): OfficeProblem | 'ok' {
  try {
    checkCanonicalZip(bytes, limits)
    return 'ok'
  } catch (error) {
    if (error instanceof GuardStop) return error.problem
    return 'failed'
  }
}

function noise(bytes: number, seed: number): Uint8Array {
  const out = new Uint8Array(bytes)
  let state = seed
  for (let i = 0; i < bytes; i++) {
    state = (state * 1103515245 + 12345) >>> 0
    out[i] = 97 + ((state >>> 16) % 4)
  }
  return out
}

function lastSignature(bytes: Uint8Array, signature: number): number {
  for (let at = bytes.length - 4; at >= 0; at--) {
    const value =
      (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
    if (value === signature) return at
  }
  throw new Error('no signature')
}

function patched(bytes: Uint8Array, change: (copy: Uint8Array) => void): Uint8Array {
  const copy = bytes.slice()
  change(copy)
  return copy
}

const BOOK = workbook({ Data: [['a', 1]] })
const EOCD = 0x06054b50
const CENTRAL = 0x02014b50

describe('checkCanonicalZip', () => {
  it('passes a workbook SheetJS wrote', () => {
    expect(isZip(BOOK)).toBe(true)
    expect(verdict(BOOK)).toBe('ok')
  })

  it('refuses a fake end record that hides a second directory (#894 review HIGH 1)', () => {
    const bytes = hiddenDirectoryBomb(48 * MIB)
    expect(bytes.length).toBeLessThan(64 * 1024)
    expect(verdict(bytes, SMALL)).toBe('failed')
    const parsed = probeSheetJS(bytes)
    expect(parsed.largestAllocation).toBeGreaterThanOrEqual(48 * MIB)
  }, 120_000)

  it('charges sizes a header declares, local, central or zip64 (#894 review HIGH 2)', () => {
    for (const where of ['local', 'central'] as const) {
      const bytes = declaredSizeBomb(64 * MIB, where)
      expect(bytes.length, where).toBeLessThan(8 * 1024)
      expect(verdict(bytes, SMALL), where).toBe(where === 'local' ? 'failed' : 'unzip-limit')
      expect(probeSheetJS(bytes).largestAllocation, where).toBeGreaterThanOrEqual(64 * MIB)
    }
    const zip64 = declaredSizeBomb(64 * MIB, 'zip64')
    expect(verdict(zip64, SMALL)).toBe('failed')
    expect(probeSheetJS(zip64).largestAllocation).toBeGreaterThanOrEqual(64 * MIB)
  }, 120_000)

  it('charges the real inflated bytes when they pass the declared size', () => {
    expect(verdict(zeroBomb(OFFICE_LIMITS.inflatedBytes + MIB))).toBe('unzip-limit')
    const lying = rawZip([zeros('xl/a.bin', 8 * MIB, 10)])
    expect(verdict(lying, { ...OFFICE_LIMITS, inflatedBytes: 4 * MIB, entryRatio: 1e9 })).toBe(
      'unzip-limit',
    )
    expect(verdict(rawZip([zeros('xl/a.bin', 4 * MIB)]))).toBe('unzip-limit')
  })

  it('counts every directory entry, so entries sharing one body add up', () => {
    const body = deflated('xl/shared.xml', noise(MIB, 1))
    const limits = { ...OFFICE_LIMITS, inflatedBytes: 8 * MIB }
    expect(
      verdict(
        rawZip(
          [body],
          Array.from({ length: 10 }, () => 0),
        ),
        limits,
      ),
    ).toBe('unzip-limit')
    expect(verdict(rawZip([body]), limits)).toBe('ok')
    const many = rawZip(
      Array.from({ length: 10 }, (_unused, i) => deflated(`xl/s${i}.xml`, noise(MIB, i))),
    )
    expect(verdict(many, limits)).toBe('unzip-limit')
  })

  it('refuses any zip whose parsers could disagree', () => {
    const end = lastSignature(BOOK, EOCD)
    const central = lastSignature(BOOK, CENTRAL)
    const cases: [string, Uint8Array][] = [
      [
        'entries on this disk differ from the total',
        patched(BOOK, (b) => {
          b[end + 8] += 1
        }),
      ],
      [
        'a disk number',
        patched(BOOK, (b) => {
          b[end + 4] = 1
        }),
      ],
      [
        'a comment length that does not reach the end',
        patched(BOOK, (b) => {
          b[end + 20] = 4
        }),
      ],
      [
        'a second end record in the comment',
        (() => {
          const tail = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0])
          const out = new Uint8Array(BOOK.length + tail.length)
          out.set(BOOK)
          out.set(tail, BOOK.length)
          out[end + 20] = tail.length
          return out
        })(),
      ],
      [
        'an encrypted entry',
        patched(BOOK, (b) => {
          b[central + 8] |= 1
        }),
      ],
      [
        'a local name that differs',
        patched(BOOK, (b) => {
          b[30] ^= 0x20
        }),
      ],
      ['a truncated file', BOOK.subarray(0, BOOK.length - 30)],
    ]
    for (const [name, bytes] of cases) {
      expect(verdict(bytes), name).not.toBe('ok')
    }
    expect(
      verdict(
        patched(BOOK, (b) => {
          b[central + 8] |= 1
        }),
      ),
    ).toBe('encrypted')
  })

  it('refuses more entries than the limit', () => {
    const many = rawZip(
      Array.from({ length: 6 }, (_unused, i) => deflated(`f${i}.xml`, noise(10, i))),
    )
    expect(verdict(many, { ...OFFICE_LIMITS, entries: 5 })).toBe('unzip-limit')
  })
})
