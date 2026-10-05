import { beforeEach, describe, expect, it } from 'vitest'
import { SHARED_BROWSER_PARTITION } from '../shared/browserProfile'
import { type BrowserPaneOwner, BrowserProfiles } from './browserProfiles'

let owners: Map<string, BrowserPaneOwner>
let scratch: Set<string>
let sandboxed: Set<string>
let profiles: BrowserProfiles

beforeEach(() => {
  owners = new Map([
    ['p1', { windowId: 'w1', workspaceId: 'ws' }],
    ['p2', { windowId: 'w1', workspaceId: 'ws' }],
    ['scratch-pane', { windowId: 'w1', workspaceId: 'scratch-ws' }],
    ['sandbox-pane', { windowId: 'w1', workspaceId: 'sandbox-ws' }],
  ])
  scratch = new Set(['scratch-ws'])
  sandboxed = new Set(['sandbox-ws'])
  profiles = new BrowserProfiles({
    ownerOf: (paneId) => owners.get(paneId) ?? null,
    isScratch: (workspaceId) => scratch.has(workspaceId),
    isSandboxed: (workspaceId) => sandboxed.has(workspaceId),
  })
})

describe('BrowserProfiles.claim', () => {
  it('grants the shared profile to a pane the window owns in an ordinary workspace', () => {
    expect(profiles.claim('p1', 'w1', 'shared')).toBe('shared')
    expect(profiles.isShared('p1')).toBe(true)
  })

  it('grants isolated when isolated is asked for', () => {
    expect(profiles.claim('p1', 'w1', 'isolated')).toBe('isolated')
    expect(profiles.isShared('p1')).toBe(false)
  })

  it('refuses the shared profile in a scratch or sandboxed workspace', () => {
    expect(profiles.claim('scratch-pane', 'w1', 'shared')).toBe('isolated')
    expect(profiles.claim('sandbox-pane', 'w1', 'shared')).toBe('isolated')
  })

  it('refuses the shared profile to a window that does not own the pane, or an unknown pane', () => {
    expect(profiles.claim('p1', 'w2', 'shared')).toBe('isolated')
    expect(profiles.claim('ghost', 'w1', 'shared')).toBe('isolated')
    expect(profiles.claim(42, 'w1', 'shared')).toBe('isolated')
  })

  it('never turns a pane that started isolated into a shared one', () => {
    profiles.claim('p1', 'w1', 'isolated')
    expect(profiles.claim('p1', 'w1', 'shared')).toBe('isolated')
  })

  it('drops a shared pane to isolated once its workspace is sandboxed', () => {
    profiles.claim('p1', 'w1', 'shared')
    sandboxed.add('ws')
    expect(profiles.claim('p1', 'w1', 'shared')).toBe('isolated')
    sandboxed.delete('ws')
    expect(profiles.claim('p1', 'w1', 'shared')).toBe('isolated')
  })

  it('keeps a shared pane shared when it moves to another window', () => {
    profiles.claim('p1', 'w1', 'shared')
    owners.set('p1', { windowId: 'w2', workspaceId: 'ws' })
    expect(profiles.claim('p1', 'w1', 'shared')).toBe('isolated')
    expect(profiles.claim('p1', 'w2', 'shared')).toBe('shared')
  })

  it('keeps an isolated pane isolated when it moves to another window', () => {
    profiles.claim('p1', 'w1', 'isolated')
    owners.set('p1', { windowId: 'w2', workspaceId: 'ws' })
    expect(profiles.claim('p1', 'w2', 'shared')).toBe('isolated')
  })

  it('forgets a closed pane', () => {
    profiles.claim('p1', 'w1', 'shared')
    profiles.forget('p1')
    expect(profiles.isShared('p1')).toBe(false)
    expect(profiles.acceptsAttach(SHARED_BROWSER_PARTITION, 'w1')).toBe(false)
  })
})

describe('BrowserProfiles.acceptsAttach', () => {
  it('accepts an isolated pane partition', () => {
    expect(profiles.acceptsAttach('ostia-browser-p1', 'w1')).toBe(true)
  })

  it('refuses any other partition', () => {
    for (const partition of ['ostia-ext-git', 'persist:other', '', undefined]) {
      expect(profiles.acceptsAttach(partition, 'w1')).toBe(false)
    }
  })

  it('refuses the shared partition when no pane of that window was granted it', () => {
    expect(profiles.acceptsAttach(SHARED_BROWSER_PARTITION, 'w1')).toBe(false)
    profiles.claim('p1', 'w1', 'isolated')
    expect(profiles.acceptsAttach(SHARED_BROWSER_PARTITION, 'w1')).toBe(false)
  })

  it('accepts the shared partition only from a window holding a granted pane, again on re-attach', () => {
    profiles.claim('p1', 'w1', 'shared')
    expect(profiles.acceptsAttach(SHARED_BROWSER_PARTITION, 'w2')).toBe(false)
    expect(profiles.acceptsAttach(SHARED_BROWSER_PARTITION, 'w1')).toBe(true)
    expect(profiles.acceptsAttach(SHARED_BROWSER_PARTITION, 'w1')).toBe(true)
  })

  it('stops accepting the shared partition once the window gives the pane away', () => {
    profiles.claim('p1', 'w1', 'shared')
    owners.set('p1', { windowId: 'w2', workspaceId: 'ws' })
    expect(profiles.acceptsAttach(SHARED_BROWSER_PARTITION, 'w1')).toBe(false)
    expect(profiles.acceptsAttach(SHARED_BROWSER_PARTITION, 'w2')).toBe(true)
  })

  it('refuses the shared partition when the workspace became sandboxed after the claim', () => {
    profiles.claim('p1', 'w1', 'shared')
    sandboxed.add('ws')
    expect(profiles.acceptsAttach(SHARED_BROWSER_PARTITION, 'w1')).toBe(false)
  })
})
