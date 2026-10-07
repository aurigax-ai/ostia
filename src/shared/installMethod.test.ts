import { describe, expect, it } from 'vitest'
import { managedUpdateMethod, updateCommandLine } from './installMethod'

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
