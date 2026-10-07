import { describe, expect, it } from 'vitest'
import { isLocalOnlyPath, syncedSettings, withLocalOnly } from './profile'

describe('profile local-only settings', () => {
  it('keeps privacy.telemetry out of the synced profile and restores the local value', () => {
    expect(isLocalOnlyPath(['privacy', 'telemetry'])).toBe(true)
    expect(isLocalOnlyPath(['privacy', 'redaction'])).toBe(false)
    const local = {
      privacy: { redaction: { enabled: true }, telemetry: { errors: true, usage: false } },
    }
    expect(syncedSettings(local)).toEqual({ privacy: { redaction: { enabled: true } } })
    const merged = { privacy: { redaction: { enabled: false }, telemetry: { errors: false } } }
    expect(withLocalOnly(merged, local)).toEqual({
      privacy: { redaction: { enabled: false }, telemetry: { errors: true, usage: false } },
    })
  })
})
