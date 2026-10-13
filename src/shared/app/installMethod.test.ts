import { describe, expect, it } from 'vitest'
import {
  type InstallMethod,
  managedUpdateMethod,
  offeredChannels,
  replacesInApp,
  updateChannelFor,
  updateCommandLine,
} from './installMethod'
import { UPDATE_CHANNELS } from './releases'

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
  it('offers main only to tarball and local installs, and beta only to brew and dmg installs', () => {
    const matrix: Record<InstallMethod, Record<string, string>> = {
      tarball: { stable: 'stable', beta: 'stable', main: 'main' },
      local: { stable: 'stable', beta: 'stable', main: 'main' },
      dmg: { stable: 'stable', beta: 'beta', main: 'stable' },
      brew: { stable: 'stable', beta: 'beta', main: 'stable' },
      apt: { stable: 'stable', beta: 'stable', main: 'stable' },
      dev: { stable: 'stable', beta: 'stable', main: 'stable' },
    }
    for (const [method, picks] of Object.entries(matrix)) {
      for (const picked of UPDATE_CHANNELS) {
        expect(updateChannelFor(method as InstallMethod, picked), `${method} ${picked}`).toBe(
          picks[picked],
        )
      }
    }
    expect(offeredChannels('dmg')).toEqual(['stable', 'beta'])
    expect(offeredChannels('tarball')).toEqual(['stable', 'main'])
    expect(offeredChannels('apt')).toEqual(['stable'])
  })
})

describe('replacesInApp', () => {
  it('replaces a dmg, tarball or local install on any channel, and a brew install only on beta', () => {
    for (const picked of UPDATE_CHANNELS) {
      for (const method of ['dmg', 'tarball', 'local'] as const) {
        expect(replacesInApp(method, picked), `${method} ${picked}`).toBe(true)
      }
      for (const method of ['apt', 'dev'] as const) {
        expect(replacesInApp(method, picked), `${method} ${picked}`).toBe(false)
      }
    }
    expect(replacesInApp('brew', 'beta')).toBe(true)
    expect(replacesInApp('brew', 'stable')).toBe(false)
    expect(replacesInApp('brew', 'main')).toBe(false)
  })
})
