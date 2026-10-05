import { describe, expect, it } from 'vitest'
import {
  type Version,
  compareVersions,
  isNewerVersion,
  parseLatestRelease,
  parseVersion,
} from './releases'

const version = (text: string): Version => {
  const parsed = parseVersion(text)
  if (!parsed) throw new Error(`not a version: ${text}`)
  return parsed
}

const RELEASE = {
  tag_name: 'v1.4.0',
  html_url: 'https://github.com/aurigax-ai/ostia/releases/tag/v1.4.0',
  draft: false,
  prerelease: false,
}

describe('parseVersion', () => {
  it('reads the numbers and the prerelease parts and ignores build metadata', () => {
    expect(parseVersion('1.20.3')).toEqual({ major: 1, minor: 20, patch: 3, prerelease: [] })
    expect(parseVersion('1.0.0-beta.2+build.7')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['beta', '2'],
    })
  })

  it('refuses text that is not a semantic version', () => {
    for (const text of ['', '1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2.3-', '1.2.3-01', ' 1.2.3']) {
      expect(parseVersion(text)).toBeNull()
    }
    expect(parseVersion(123)).toBeNull()
    expect(parseVersion(`1.2.3-${'a'.repeat(80)}`)).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions(version('0.10.0'), version('0.9.9'))).toBe(1)
    expect(compareVersions(version('1.0.0'), version('0.99.99'))).toBe(1)
    expect(compareVersions(version('1.2.3'), version('1.2.10'))).toBe(-1)
    expect(compareVersions(version('2.0.0'), version('2.0.0'))).toBe(0)
  })

  it('follows the semver precedence chain for prereleases', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]
    for (let i = 1; i < chain.length; i++) {
      expect(compareVersions(version(chain[i - 1]), version(chain[i]))).toBe(-1)
      expect(compareVersions(version(chain[i]), version(chain[i - 1]))).toBe(1)
    }
  })

  it('treats versions that differ only in build metadata as equal', () => {
    expect(compareVersions(version('1.0.0+a'), version('1.0.0+b'))).toBe(0)
  })
})

describe('isNewerVersion', () => {
  it('is true only for a strictly newer version', () => {
    expect(isNewerVersion('0.3.0', '0.2.0')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '1.0.0-rc.1')).toBe(true)
  })

  it('is false when either side is not a version', () => {
    expect(isNewerVersion('latest', '0.2.0')).toBe(false)
    expect(isNewerVersion('9.9.9', 'dev')).toBe(false)
  })
})

describe('parseLatestRelease', () => {
  it('returns the version and the release page of a stable release', () => {
    expect(parseLatestRelease(RELEASE)).toEqual({
      ok: true,
      release: { version: '1.4.0', url: 'https://github.com/aurigax-ai/ostia/releases/tag/v1.4.0' },
    })
  })

  it('ignores drafts, prereleases and prerelease tags', () => {
    const notStable = { ok: false, reason: 'not-stable' }
    expect(parseLatestRelease({ ...RELEASE, draft: true })).toEqual(notStable)
    expect(parseLatestRelease({ ...RELEASE, prerelease: true })).toEqual(notStable)
    expect(
      parseLatestRelease({
        ...RELEASE,
        tag_name: 'v1.4.0-beta.1',
        html_url: 'https://github.com/aurigax-ai/ostia/releases/tag/v1.4.0-beta.1',
      }),
    ).toEqual(notStable)
  })

  it('refuses a release page that is not https on github.com under the repository', () => {
    const malformed = { ok: false, reason: 'malformed' }
    for (const html_url of [
      'http://github.com/aurigax-ai/ostia/releases/tag/v1.4.0',
      'https://github.com.evil.example/aurigax-ai/ostia/releases/tag/v1.4.0',
      'https://evil.example/aurigax-ai/ostia/releases/tag/v1.4.0',
      'https://github.com:8443/aurigax-ai/ostia/releases/tag/v1.4.0',
      'https://user@github.com/aurigax-ai/ostia/releases/tag/v1.4.0',
      'https://github.com/someone-else/ostia/releases/tag/v1.4.0',
      'https://github.com/aurigax-ai/other/releases/tag/v1.4.0',
      'https://github.com/aurigax-ai/ostia/releases/tag/v1.4.0/../../../../evil/repo',
      'https://github.com/aurigax-ai/ostia/releases/tag/v9.9.9',
      'https://github.com/aurigax-ai/ostia/releases/tag/v1.4.0?next=https://evil.example',
      'https://github.com/aurigax-ai/ostia/releases/tag/v1.4.0#x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      '',
      null,
    ]) {
      expect(parseLatestRelease({ ...RELEASE, html_url })).toEqual(malformed)
    }
  })

  it('refuses a response without a valid tag or flags', () => {
    const malformed = { ok: false, reason: 'malformed' }
    expect(parseLatestRelease(null)).toEqual(malformed)
    expect(parseLatestRelease('v1.4.0')).toEqual(malformed)
    expect(parseLatestRelease([])).toEqual(malformed)
    expect(parseLatestRelease({ ...RELEASE, tag_name: 'nightly' })).toEqual(malformed)
    expect(parseLatestRelease({ ...RELEASE, tag_name: 14 })).toEqual(malformed)
    expect(parseLatestRelease({ ...RELEASE, draft: undefined })).toEqual(malformed)
    expect(parseLatestRelease({ ...RELEASE, prerelease: 'no' })).toEqual(malformed)
  })
})
