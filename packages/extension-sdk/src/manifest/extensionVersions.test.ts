import { describe, expect, it } from 'vitest'
import {
  isNewerVersion,
  isOlderVersion,
  isPrerelease,
  lowestApiNeeded,
  newestCompatible,
} from './extensionVersions'

const release = (version: string, api = '7.0') => ({ version, api })

describe('version order', () => {
  it('calls only a higher semver newer, never a downgrade', () => {
    expect(isNewerVersion('1.2.0', '1.1.9')).toBe(true)
    expect(isNewerVersion('1.1.0', '1.1.0')).toBe(false)
    expect(isNewerVersion('1.0.9', '1.1.0')).toBe(false)
    expect(isOlderVersion('1.0.9', '1.1.0')).toBe(true)
    expect(isNewerVersion('1.1.0', '1.1.0-rc.2')).toBe(true)
    expect(isNewerVersion('1.1.0-rc.2', '1.1.0')).toBe(false)
  })

  it('falls back to inequality when a version is not semver', () => {
    expect(isNewerVersion('2', '1')).toBe(true)
    expect(isNewerVersion('1', '1')).toBe(false)
    expect(isOlderVersion('1', '2')).toBe(false)
  })

  it('tells a pre-release from a release', () => {
    expect(isPrerelease('1.2.0-rc.1')).toBe(true)
    expect(isPrerelease('1.2.0')).toBe(false)
  })
})

describe('newestCompatible', () => {
  const all = [
    release('1.0.0', '7.0'),
    release('1.1.0', '7.5'),
    release('1.2.0', '7.9'),
    release('1.3.0-rc.1', '7.5'),
  ]

  it('picks the newest release the app API accepts', () => {
    expect(newestCompatible(all, '7.6', false)?.version).toBe('1.1.0')
    expect(newestCompatible(all, '7.9', false)?.version).toBe('1.2.0')
    expect(newestCompatible(all, '8.0', false)).toBeNull()
  })

  it('offers a pre-release only when asked', () => {
    expect(newestCompatible(all, '7.6', true)?.version).toBe('1.3.0-rc.1')
    expect(newestCompatible(all, '7.6', false)?.version).toBe('1.1.0')
  })

  it('names the lowest API any release needs', () => {
    expect(lowestApiNeeded([release('2.0.0', '7.9'), release('3.0.0', '7.12')])).toBe('7.9')
    expect(lowestApiNeeded([])).toBeNull()
  })
})
