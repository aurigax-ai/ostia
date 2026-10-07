import { describe, expect, it } from 'vitest'
import { expandSyncDir } from './syncDir'

describe('expandSyncDir', () => {
  it('accepts only absolute or home-relative sync dirs', () => {
    expect(expandSyncDir('relative/dir')).toBeNull()
    expect(expandSyncDir('')).toBeNull()
    expect(expandSyncDir(42)).toBeNull()
    expect(expandSyncDir('/tmp/x/../y')).toBe('/tmp/y')
    expect(expandSyncDir('~/sync')?.endsWith('/sync')).toBe(true)
  })
})
