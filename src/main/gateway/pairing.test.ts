import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumeCode, newCode, resetCodes } from './pairing'

describe('gateway/pairing', () => {
  afterEach(() => {
    resetCodes()
    vi.useRealTimers()
  })

  it('newCode mints an 8-char code from the QR/typo-resistant alphabet', () => {
    const code = newCode()
    expect(code).toHaveLength(8)
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
  })

  it('newCode mints distinct codes across calls', () => {
    const codes = new Set(Array.from({ length: 20 }, () => newCode()))
    expect(codes.size).toBe(20)
  })

  it('consumeCode accepts a freshly-minted, unexpired code', () => {
    const code = newCode()
    expect(consumeCode(code)).toBe(true)
  })

  it('consumeCode is single-use: a second redemption of the same code fails', () => {
    const code = newCode()
    expect(consumeCode(code)).toBe(true)
    expect(consumeCode(code)).toBe(false)
  })

  it('consumeCode rejects an unknown code', () => {
    expect(consumeCode('NOTREAL1')).toBe(false)
  })

  it('consumeCode rejects a code past its 120s TTL', () => {
    vi.useFakeTimers()
    const code = newCode()
    vi.advanceTimersByTime(120_001)
    expect(consumeCode(code)).toBe(false)
  })

  it('consumeCode accepts a code right up to (inclusive of) its TTL boundary', () => {
    vi.useFakeTimers()
    const code = newCode()
    vi.advanceTimersByTime(120_000)
    expect(consumeCode(code)).toBe(true)
  })

  it('resetCodes drops every pending code', () => {
    const code = newCode()
    resetCodes()
    expect(consumeCode(code)).toBe(false)
  })
})
