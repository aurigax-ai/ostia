import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  auditPairAttempt,
  checkPairRateLimit,
  consumeCode,
  newCode,
  resetCodes,
  resetPairRateLimit,
} from './pairing'

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

function unsetEnv(key: string): void {
  delete process.env[key]
}

describe('gateway/pairing — rate limit + audit log', () => {
  let dir: string
  let prevXdg: string | undefined

  beforeEach(() => {
    dir = join(tmpdir(), `pine-gateway-pairing-test-${process.pid}-${Date.now()}-${Math.random()}`)
    prevXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (prevXdg === undefined) unsetEnv('XDG_DATA_HOME')
    else process.env.XDG_DATA_HOME = prevXdg
    rmSync(dir, { recursive: true, force: true })
    resetPairRateLimit()
  })

  it('allows up to 5 attempts per IP within the window', () => {
    for (let i = 0; i < 5; i++) {
      expect(checkPairRateLimit('1.2.3.4')).toBe(true)
    }
  })

  it('rejects the 6th attempt from the same IP within the window', () => {
    for (let i = 0; i < 5; i++) checkPairRateLimit('1.2.3.4')
    expect(checkPairRateLimit('1.2.3.4')).toBe(false)
  })

  it('tracks each source IP independently', () => {
    for (let i = 0; i < 5; i++) checkPairRateLimit('1.2.3.4')
    expect(checkPairRateLimit('1.2.3.4')).toBe(false)
    expect(checkPairRateLimit('5.6.7.8')).toBe(true)
  })

  it('resetPairRateLimit drops every counter', () => {
    for (let i = 0; i < 5; i++) checkPairRateLimit('1.2.3.4')
    resetPairRateLimit()
    expect(checkPairRateLimit('1.2.3.4')).toBe(true)
  })

  it('auditPairAttempt appends a newline-delimited JSON line per call', () => {
    auditPairAttempt('1.2.3.4', 'ok')
    auditPairAttempt('1.2.3.4', 'invalid-code')
    const path = join(dir, 'ostia', 'gateway-pair-audit.log')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toMatchObject({ ip: '1.2.3.4', outcome: 'ok' })
    expect(JSON.parse(lines[1])).toMatchObject({ ip: '1.2.3.4', outcome: 'invalid-code' })
  })
})
