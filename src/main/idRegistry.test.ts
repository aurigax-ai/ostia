import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  getByPaneId,
  markManager,
  panesOwnedBy,
  registerExtension,
  registerPane,
  rehomePanes,
  rehomeWorkspace,
  removePane,
  removeWindow,
  resolveExternal,
  resolveToken,
  setPaneIdSalt,
  stablePaneExternalId,
  workspaceHasManager,
} from './idRegistry'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_RE = /^[0-9a-f]{64}$/

describe('idRegistry', () => {
  it('mints a uuid externalId and a 64-hex-char token', () => {
    const id = registerPane({ windowId: 'w-mint', workspaceId: 's-mint', paneId: 'p-mint' })
    expect(id.externalId).toMatch(UUID_RE)
    expect(id.token).toMatch(TOKEN_RE)
  })

  it('is idempotent per paneId: re-registering returns the same identity but updates windowId/workspaceId', () => {
    const first = registerPane({ windowId: 'w-idem-1', workspaceId: 's-idem-1', paneId: 'p-idem' })
    const second = registerPane({ windowId: 'w-idem-2', workspaceId: 's-idem-2', paneId: 'p-idem' })

    expect(second.externalId).toBe(first.externalId)
    expect(second.token).toBe(first.token)
    expect(second.windowId).toBe('w-idem-2')
    expect(second.workspaceId).toBe('s-idem-2')

    expect(first.windowId).toBe('w-idem-2')
    expect(first.workspaceId).toBe('s-idem-2')
  })

  it('keeps the known workspaceId when re-registered without one (pty attach after pane-created)', () => {
    registerPane({ windowId: 'w-keep', workspaceId: 's-keep', paneId: 'p-keep' })
    const again = registerPane({ windowId: 'w-keep-2', workspaceId: '', paneId: 'p-keep' })
    expect(again.workspaceId).toBe('s-keep')
    expect(again.windowId).toBe('w-keep-2')
  })

  it('resolveExternal/resolveToken/getByPaneId all round-trip to the same identity', () => {
    const id = registerPane({ windowId: 'w-rt', workspaceId: 's-rt', paneId: 'p-rt' })

    expect(resolveExternal(id.externalId)).toBe(id)
    expect(resolveToken(id.token)).toBe(id)
    expect(getByPaneId(id.paneId)).toBe(id)
  })

  it('two different panes get distinct externalIds AND distinct tokens', () => {
    const a = registerPane({ windowId: 'w-dist', workspaceId: 's-dist', paneId: 'p-dist-a' })
    const b = registerPane({ windowId: 'w-dist', workspaceId: 's-dist', paneId: 'p-dist-b' })

    expect(a.externalId).not.toBe(b.externalId)
    expect(a.token).not.toBe(b.token)
  })

  it('removePane clears all three indexes', () => {
    const id = registerPane({ windowId: 'w-rm', workspaceId: 's-rm', paneId: 'p-rm' })
    expect(getByPaneId('p-rm')).toBe(id)

    removePane('p-rm')

    expect(resolveExternal(id.externalId)).toBeUndefined()
    expect(resolveToken(id.token)).toBeUndefined()
    expect(getByPaneId('p-rm')).toBeUndefined()
  })

  it('removePane on an unknown paneId is a no-op (does not throw)', () => {
    expect(() => removePane('p-never-registered')).not.toThrow()
  })

  it('removeWindow(wid) removes exactly the panes for that window and leaves others', () => {
    const w1a = registerPane({
      windowId: 'w-multi-1',
      workspaceId: 's-multi',
      paneId: 'p-multi-1a',
    })
    const w1b = registerPane({
      windowId: 'w-multi-1',
      workspaceId: 's-multi',
      paneId: 'p-multi-1b',
    })
    const w2a = registerPane({
      windowId: 'w-multi-2',
      workspaceId: 's-multi',
      paneId: 'p-multi-2a',
    })

    removeWindow('w-multi-1')

    expect(getByPaneId('p-multi-1a')).toBeUndefined()
    expect(getByPaneId('p-multi-1b')).toBeUndefined()
    expect(resolveExternal(w1a.externalId)).toBeUndefined()
    expect(resolveExternal(w1b.externalId)).toBeUndefined()

    expect(getByPaneId('p-multi-2a')).toBe(w2a)
    expect(resolveExternal(w2a.externalId)).toBe(w2a)
  })

  it('rehomePanes moves a pane to another window and keeps its token', () => {
    const moving = registerPane({ windowId: 'w-src', workspaceId: 's-move', paneId: 'p-move' })
    const token = moving.token

    rehomePanes(['p-move', 'p-unknown'], 'w-dst')

    expect(getByPaneId('p-move')?.windowId).toBe('w-dst')
    expect(resolveToken(token)).toBe(moving)
    removeWindow('w-src')
    expect(getByPaneId('p-move')).toBe(moving)
  })

  it('panesOwnedBy refuses a pane another window owns', () => {
    registerPane({ windowId: 'w-own-1', workspaceId: 's-own', paneId: 'p-own-1' })
    registerPane({ windowId: 'w-own-2', workspaceId: 's-own', paneId: 'p-own-2' })

    expect(panesOwnedBy(['p-own-1', 'p-never-registered'], 'w-own-1')).toBe(true)
    expect(panesOwnedBy(['p-own-1', 'p-own-2'], 'w-own-1')).toBe(false)
  })

  it('moves every pane of a merged workspace to the target and keeps their tokens', () => {
    const a = registerPane({ windowId: 'w-merge', workspaceId: 's-merge-src', paneId: 'p-merge-a' })
    const b = registerPane({ windowId: 'w-merge', workspaceId: 's-merge-src', paneId: 'p-merge-b' })
    registerPane({ windowId: 'w-merge', workspaceId: 's-merge-dst', paneId: 'p-merge-c' })
    const tokens = [a.token, b.token]

    const moved = rehomeWorkspace('s-merge-src', 's-merge-dst')

    expect(moved.map((m) => m.paneId).sort()).toEqual(['p-merge-a', 'p-merge-b'])
    expect(getByPaneId('p-merge-a')?.workspaceId).toBe('s-merge-dst')
    expect(getByPaneId('p-merge-b')?.workspaceId).toBe('s-merge-dst')
    expect([resolveToken(tokens[0])?.paneId, resolveToken(tokens[1])?.paneId]).toEqual([
      'p-merge-a',
      'p-merge-b',
    ])
  })

  it('knows which workspace holds the manager pane', () => {
    registerPane({ windowId: 'w-mgr', workspaceId: 's-mgr', paneId: 'p-mgr' })
    registerPane({ windowId: 'w-mgr', workspaceId: 's-plain', paneId: 'p-plain' })
    markManager('p-mgr')

    expect(workspaceHasManager('s-mgr')).toBe(true)
    expect(workspaceHasManager('s-plain')).toBe(false)
  })

  it('gives a pane the same externalId after a restart but a fresh token', () => {
    const salt = randomBytes(32)
    setPaneIdSalt(salt)
    const before = registerPane({ windowId: 'w-1', workspaceId: 's-r', paneId: 'pane-ab12cd-3' })
    const { externalId, token } = before
    removeWindow('w-1')
    setPaneIdSalt(Buffer.from(salt))
    const after = registerPane({ windowId: 'w-2', workspaceId: 's-r', paneId: 'pane-ab12cd-3' })

    expect(after.externalId).toBe(externalId)
    expect(after.externalId).toMatch(UUID_RE)
    expect(after.token).not.toBe(token)
    expect(resolveToken(token)).toBeUndefined()
    expect(resolveExternal(externalId)).toBe(after)
  })

  it('derives different externalIds for different panes and different installs', () => {
    const salt = randomBytes(32)
    setPaneIdSalt(salt)
    const a = stablePaneExternalId('pane-ab12cd-1')
    const b = stablePaneExternalId('pane-ab12cd-2')
    setPaneIdSalt(randomBytes(32))
    const otherInstall = stablePaneExternalId('pane-ab12cd-1')

    expect(a).toMatch(UUID_RE)
    expect(a).not.toBe(b)
    expect(a).not.toBe(otherInstall)
  })

  it('keeps minting random externalIds for extensions', () => {
    const first = registerExtension('ext.stable-check').externalId
    const second = registerExtension('ext.stable-check').externalId
    expect(first).toMatch(UUID_RE)
    expect(second).not.toBe(first)
  })
})
