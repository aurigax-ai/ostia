import { describe, expect, it } from 'vitest'
import {
  SHARED_BROWSER_PARTITION,
  browserPartition,
  browserProfileFor,
  isIsolatedBrowserPartition,
  parseBrowserProfile,
} from './browserProfile'

describe('browserProfileFor', () => {
  it('gives a pane the human opens in an ordinary workspace the shared profile', () => {
    expect(browserProfileFor({ opener: 'human', scratch: false, sandboxed: false })).toBe('shared')
  })

  it('keeps a pane an agent opens isolated', () => {
    expect(browserProfileFor({ opener: 'agent', scratch: false, sandboxed: false })).toBe(
      'isolated',
    )
  })

  it('keeps every pane of a scratch workspace isolated, whoever opens it', () => {
    expect(browserProfileFor({ opener: 'human', scratch: true, sandboxed: false })).toBe('isolated')
    expect(browserProfileFor({ opener: 'agent', scratch: true, sandboxed: false })).toBe('isolated')
  })

  it('keeps every pane of a sandboxed workspace isolated, whoever opens it', () => {
    expect(browserProfileFor({ opener: 'human', scratch: false, sandboxed: true })).toBe('isolated')
    expect(browserProfileFor({ opener: 'agent', scratch: false, sandboxed: true })).toBe('isolated')
  })
})

describe('browser partitions', () => {
  it('names one persistent partition for the shared profile and one in-memory partition per isolated pane', () => {
    expect(browserPartition('shared', 'p1')).toBe(SHARED_BROWSER_PARTITION)
    expect(SHARED_BROWSER_PARTITION.startsWith('persist:')).toBe(true)
    expect(browserPartition('isolated', 'p1')).toBe('ostia-browser-p1')
    expect(browserPartition('isolated', 'p1')).not.toBe(browserPartition('isolated', 'p2'))
  })

  it('recognises only isolated pane partitions as isolated', () => {
    expect(isIsolatedBrowserPartition('ostia-browser-p1')).toBe(true)
    expect(isIsolatedBrowserPartition(SHARED_BROWSER_PARTITION)).toBe(false)
    expect(isIsolatedBrowserPartition('persist:pine-browser-p1')).toBe(false)
    expect(isIsolatedBrowserPartition('pine-ext-git')).toBe(false)
    expect(isIsolatedBrowserPartition(undefined)).toBe(false)
  })

  it('parses anything but "shared" as isolated', () => {
    expect(parseBrowserProfile('shared')).toBe('shared')
    for (const raw of ['isolated', undefined, null, 'SHARED', 1]) {
      expect(parseBrowserProfile(raw)).toBe('isolated')
    }
  })
})
