import { describe, expect, it } from 'vitest'
import { wakeReason } from './wakeReason'

describe('wakeReason', () => {
  it('keeps plain text and drops anything that is not a string', () => {
    expect(wakeReason('its agent exited with code 1')).toBe('its agent exited with code 1')
    expect(wakeReason(7)).toBeUndefined()
    expect(wakeReason('  ')).toBeUndefined()
  })

  it('strips control characters and escape sequences so the answer stays one plain line', () => {
    expect(wakeReason('bad\x1b[31m\r\nreason\x07')).toBe('bad[31mreason')
  })

  it('caps the length', () => {
    expect(wakeReason('x'.repeat(5000))).toHaveLength(200)
  })
})
