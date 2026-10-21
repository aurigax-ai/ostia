import { describe, expect, it } from 'vitest'
import { exceedsFloor, floorProblems } from '../scripts/extensionFloor.mjs'
import {
  extensionTag,
  parseExtensionTag,
  parseSdkTag,
  releaseProblems,
  sdkReleaseProblems,
  sdkTag,
} from '../scripts/extensionRelease.mjs'

describe('extension tags', () => {
  it('round-trips ext/<id>/v<version>, pre-releases included', () => {
    expect(extensionTag('lsp-bash', '1.2.3')).toBe('ext/lsp-bash/v1.2.3')
    expect(parseExtensionTag('ext/lsp-bash/v1.2.3')).toEqual({ id: 'lsp-bash', version: '1.2.3' })
    expect(parseExtensionTag('ext/trellis/v1.6.0-rc.1')).toEqual({
      id: 'trellis',
      version: '1.6.0-rc.1',
    })
  })

  it('refuses anything else', () => {
    for (const tag of [
      'v0.5.12',
      'sdk-v0.5.12',
      'ext/lsp-bash/1.2.3',
      'ext/lsp-bash/v1.2',
      'ext/lsp-bash/vv1.2.3',
      'ext/Lsp/v1.2.3',
      'ext//v1.2.3',
      'ext/lsp-bash/v01.2.3',
    ]) {
      expect(parseExtensionTag(tag)).toBeNull()
    }
  })

  it('wants the id in the marketplace and the version equal to the manifest', () => {
    const from = { listed: ['lsp-bash'], versionOf: () => '1.2.3' }
    expect(releaseProblems('ext/lsp-bash/v1.2.3', from)).toEqual([])
    expect(releaseProblems('ext/lsp-bash/v1.2.4', from)).toEqual([
      'ext/lsp-bash/v1.2.4 says 1.2.4 but src/extensions/lsp-bash/ostia.json says 1.2.3',
    ])
    expect(releaseProblems('ext/agent/v1.0.0', from)).toEqual([
      'agent is not an extension of marketplace/ostia-marketplace.json',
    ])
    expect(releaseProblems('nonsense', from)).toHaveLength(1)
  })
})

describe('SDK tags', () => {
  it('are sdk-v<version> and must equal the package version', () => {
    expect(sdkTag('0.5.12')).toBe('sdk-v0.5.12')
    expect(parseSdkTag('sdk-v0.5.12-rc.1')).toEqual({ version: '0.5.12-rc.1' })
    for (const tag of ['v0.5.12', 'sdk-0.5.12', 'sdk-v0.5', 'ext/a-b/v1.0.0']) {
      expect(parseSdkTag(tag)).toBeNull()
    }
    expect(sdkReleaseProblems('sdk-v0.5.12', '0.5.12')).toEqual([])
    expect(sdkReleaseProblems('sdk-v0.5.13', '0.5.12')).toEqual([
      'sdk-v0.5.13 says 0.5.13 but the SDK package says 0.5.12',
    ])
  })
})

describe('the API floor', () => {
  it('refuses an extension that declares a newer API than the latest stable app has', () => {
    expect(exceedsFloor('7.7', '7.7')).toBe(false)
    expect(exceedsFloor('7.0', '7.7')).toBe(false)
    expect(exceedsFloor('7.8', '7.7')).toBe(true)
    expect(exceedsFloor('8.0', '7.7')).toBe(true)
    expect(exceedsFloor('6.9', '7.7')).toBe(true)
    expect(exceedsFloor('seven', '7.7')).toBe(true)
  })

  it('names each way an extension steps past the floor', () => {
    const base = { declared: '7.7', appApi: '7.7', sdk: '0.5.11', sdkApi: '7.7' }
    expect(floorProblems(base)).toEqual([])
    expect(floorProblems({ ...base, declared: '7.6', sdkApi: '7.5' })).toEqual([
      'declares extension API 7.6, newer than 7.5 of the SDK 0.5.11 it is typed against',
    ])
    expect(floorProblems({ ...base, declared: '7.8' })).toEqual([
      'declares extension API 7.8, newer than 7.7 of the latest stable app',
      'declares extension API 7.8, newer than 7.7 of the SDK 0.5.11 it is typed against',
    ])
    expect(floorProblems({ ...base, sdkApi: '7.8' })).toEqual([
      'is typed against SDK 0.5.11 (extension API 7.8), newer than 7.7 of the latest stable app',
    ])
  })
})
