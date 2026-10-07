import { describe, expect, it } from 'vitest'
import { buildVersion, telemetryStamp } from '../../scripts/buildVersion.mjs'
import { parseBuildInfo, parseTelemetryStamp, releaseVersion } from './buildInfo'
import { isNewerVersion, parseVersion } from './releases'

describe('buildVersion', () => {
  it('is the plain version for a clean checkout at its release tag', () => {
    expect(buildVersion('0.5.9', { tags: ['v0.5.9'], commit: '1a2b3c', dirty: false })).toBe(
      '0.5.9',
    )
  })

  it('carries the commit as build metadata for any other clean commit', () => {
    expect(buildVersion('0.5.9', { tags: [], commit: '1a2b3c', dirty: false })).toBe(
      '0.5.9+sha.1a2b3c',
    )
    expect(buildVersion('0.5.9', { tags: ['v0.5.8'], commit: '1a2b3c', dirty: false })).toBe(
      '0.5.9+sha.1a2b3c',
    )
  })

  it('marks uncommitted changes as dirty, even at the release tag', () => {
    expect(buildVersion('0.5.9', { tags: [], commit: '1a2b3c', dirty: true })).toBe(
      '0.5.9+sha.1a2b3c.dirty',
    )
    expect(buildVersion('0.5.9', { tags: ['v0.5.9'], commit: '1a2b3c', dirty: true })).toBe(
      '0.5.9+sha.1a2b3c.dirty',
    )
  })

  it('keeps a prerelease base before the build metadata', () => {
    const version = buildVersion('0.5.9-rc.3', { tags: [], commit: '1a2b3c', dirty: true })
    expect(version).toBe('0.5.9-rc.3+sha.1a2b3c.dirty')
    expect(parseVersion(version)).not.toBeNull()
  })

  it('falls back to the package version without git', () => {
    expect(buildVersion('0.5.9', null)).toBe('0.5.9')
  })
})

describe('releaseVersion', () => {
  it('drops the build metadata so a local build is not offered its own release', () => {
    expect(releaseVersion('0.5.9+sha.1a2b3c.dirty')).toBe('0.5.9')
    expect(releaseVersion('0.5.9-rc.3+sha.1a2b3c')).toBe('0.5.9-rc.3')
    expect(releaseVersion('0.5.9')).toBe('0.5.9')
    expect(isNewerVersion('0.5.9', releaseVersion('0.5.9+sha.1a2b3c'))).toBe(false)
  })
})

describe('parseBuildInfo', () => {
  it('keeps the version and build time and refuses anything else', () => {
    expect(
      parseBuildInfo({ version: '0.5.9+sha.1a2b3c', builtAt: '2026-10-06T00:00:00Z', x: 1 }),
    ).toEqual({ version: '0.5.9+sha.1a2b3c', builtAt: '2026-10-06T00:00:00Z' })
    expect(parseBuildInfo({ version: '0.5.9' })).toBeNull()
    expect(parseBuildInfo(null)).toBeNull()
  })
})

describe('telemetryStamp', () => {
  it('stamps the key and host only when the release build has both', () => {
    expect(
      telemetryStamp({ OSTIA_TELEMETRY_KEY: 'phc_x', OSTIA_TELEMETRY_HOST: 'https://h' }),
    ).toEqual({ key: 'phc_x', host: 'https://h' })
    expect(telemetryStamp({ OSTIA_TELEMETRY_KEY: 'phc_x' })).toBeNull()
    expect(
      telemetryStamp({ OSTIA_TELEMETRY_KEY: '', OSTIA_TELEMETRY_HOST: 'https://h' }),
    ).toBeNull()
    expect(telemetryStamp({})).toBeNull()
  })

  it('is read back from the stamp only when complete, and never invented', () => {
    expect(
      parseBuildInfo({
        version: '1.0.0',
        builtAt: 't',
        telemetry: { key: 'phc_x', host: 'https://h' },
      }),
    ).toEqual({ version: '1.0.0', builtAt: 't', telemetry: { key: 'phc_x', host: 'https://h' } })
    expect(parseBuildInfo({ version: '1.0.0', builtAt: 't', telemetry: { key: 'phc_x' } })).toEqual(
      {
        version: '1.0.0',
        builtAt: 't',
      },
    )
    expect(parseBuildInfo({ version: '1.0.0', builtAt: 't' })).toEqual({
      version: '1.0.0',
      builtAt: 't',
    })
    expect(parseTelemetryStamp({ key: '', host: 'https://h' })).toBeNull()
    expect(parseTelemetryStamp('x')).toBeNull()
  })
})
