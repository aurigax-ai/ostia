import { describe, expect, it } from 'vitest'
import { HostPaneGrants } from './hostPanes'

describe('HostPaneGrants', () => {
  it('SBX-C90 opens a host pane only for the exact command the human just approved, once', () => {
    let now = 1000
    const grants = new HostPaneGrants({ now: () => now, ttlMs: 60_000 })
    expect(grants.claim('system', "'pacman' '-S' 'jq'")).toBeNull()
    grants.offer('system', "'pacman' '-S' 'jq'")
    expect(grants.claim('other-ext', "'pacman' '-S' 'jq'")).toBeNull()
    expect(grants.claim('system', "'pacman' '-S' 'curl'")).toBeNull()
    const token = grants.claim('system', "'pacman' '-S' 'jq'")
    expect(token).toMatch(/^[a-f0-9]{32,}$/)
    expect(grants.claim('system', "'pacman' '-S' 'jq'")).toBeNull()
    expect(grants.consume('bogus')).toBe(false)
    expect(grants.consume(token ?? '')).toBe(true)
    expect(grants.consume(token ?? '')).toBe(false)
    grants.offer('system', "'pacman' '-S' 'jq'")
    now += 61_000
    expect(grants.claim('system', "'pacman' '-S' 'jq'")).toBeNull()
  })
})
