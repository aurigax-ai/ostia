import { describe, expect, it } from 'vitest'
import { readGitSettings } from './settings'

describe('readGitSettings', () => {
  it('polls every 10 seconds and shows diff stats by default', () => {
    expect(readGitSettings({})).toEqual({ pollMs: 10_000, showDiffStats: true })
  })

  it('raises a poll interval below 2 seconds to 2 seconds', () => {
    expect(readGitSettings({ pollSeconds: 0 }).pollMs).toBe(2_000)
  })

  it('caps the poll interval at an hour so setInterval never overflows', () => {
    const { pollMs } = readGitSettings({ pollSeconds: 3_000_000 })
    expect(pollMs).toBe(3_600_000)
    expect(pollMs).toBeLessThan(2 ** 31 - 1)
  })

  it('hides diff stats only when the setting is false', () => {
    expect(readGitSettings({ showDiffStats: false }).showDiffStats).toBe(false)
  })
})
