import { describe, expect, it } from 'vitest'
import {
  isReplaceable,
  managedUpdateMethod,
  updateChannelFor,
  updateCommandLine,
} from './installMethod'

describe('updateCommandLine', () => {
  it('is the fixed command per managed method, without any version', () => {
    expect(updateCommandLine('apt')).toBe(
      'sudo apt update && sudo apt install --only-upgrade ostia',
    )
    expect(updateCommandLine('brew')).toBe('brew upgrade --cask ostia')
  })

  it('is null for a method with no package manager', () => {
    for (const method of ['local', 'tarball', 'dmg', 'dev'] as const) {
      expect(updateCommandLine(method)).toBeNull()
      expect(managedUpdateMethod(method)).toBeNull()
    }
  })
})

describe('updateChannelFor', () => {
  it('offers the main channel only to tarball and local installs', () => {
    expect(['tarball', 'local'].every((m) => isReplaceable(m as 'tarball'))).toBe(true)
    for (const method of ['apt', 'brew', 'dmg', 'dev'] as const) {
      expect(isReplaceable(method)).toBe(false)
      expect(updateChannelFor(method, 'main')).toBe('stable')
    }
    expect(updateChannelFor('tarball', 'main')).toBe('main')
    expect(updateChannelFor('local', 'stable')).toBe('stable')
  })
})
