import { describe, expect, it } from 'vitest'
import {
  getByPaneId,
  registerPane,
  removePane,
  removeWindow,
  resolveExternal,
  resolveToken,
} from './idRegistry'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_RE = /^[0-9a-f]{64}$/

describe('idRegistry', () => {
  it('mints a uuid externalId and a 64-hex-char token', () => {
    const id = registerPane({ windowId: 'w-mint', sessionId: 's-mint', paneId: 'p-mint' })
    expect(id.externalId).toMatch(UUID_RE)
    expect(id.token).toMatch(TOKEN_RE)
  })

  it('is idempotent per paneId: re-registering returns the same identity but updates windowId/sessionId', () => {
    const first = registerPane({ windowId: 'w-idem-1', sessionId: 's-idem-1', paneId: 'p-idem' })
    const second = registerPane({ windowId: 'w-idem-2', sessionId: 's-idem-2', paneId: 'p-idem' })

    expect(second.externalId).toBe(first.externalId)
    expect(second.token).toBe(first.token)
    expect(second.windowId).toBe('w-idem-2')
    expect(second.sessionId).toBe('s-idem-2')

    expect(first.windowId).toBe('w-idem-2')
    expect(first.sessionId).toBe('s-idem-2')
  })

  it('keeps the known sessionId when re-registered without one (pty attach after pane-created)', () => {
    registerPane({ windowId: 'w-keep', sessionId: 's-keep', paneId: 'p-keep' })
    const again = registerPane({ windowId: 'w-keep-2', sessionId: '', paneId: 'p-keep' })
    expect(again.sessionId).toBe('s-keep')
    expect(again.windowId).toBe('w-keep-2')
  })

  it('resolveExternal/resolveToken/getByPaneId all round-trip to the same identity', () => {
    const id = registerPane({ windowId: 'w-rt', sessionId: 's-rt', paneId: 'p-rt' })

    expect(resolveExternal(id.externalId)).toBe(id)
    expect(resolveToken(id.token)).toBe(id)
    expect(getByPaneId(id.paneId)).toBe(id)
  })

  it('two different panes get distinct externalIds AND distinct tokens', () => {
    const a = registerPane({ windowId: 'w-dist', sessionId: 's-dist', paneId: 'p-dist-a' })
    const b = registerPane({ windowId: 'w-dist', sessionId: 's-dist', paneId: 'p-dist-b' })

    expect(a.externalId).not.toBe(b.externalId)
    expect(a.token).not.toBe(b.token)
  })

  it('removePane clears all three indexes', () => {
    const id = registerPane({ windowId: 'w-rm', sessionId: 's-rm', paneId: 'p-rm' })
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
    const w1a = registerPane({ windowId: 'w-multi-1', sessionId: 's-multi', paneId: 'p-multi-1a' })
    const w1b = registerPane({ windowId: 'w-multi-1', sessionId: 's-multi', paneId: 'p-multi-1b' })
    const w2a = registerPane({ windowId: 'w-multi-2', sessionId: 's-multi', paneId: 'p-multi-2a' })

    removeWindow('w-multi-1')

    expect(getByPaneId('p-multi-1a')).toBeUndefined()
    expect(getByPaneId('p-multi-1b')).toBeUndefined()
    expect(resolveExternal(w1a.externalId)).toBeUndefined()
    expect(resolveExternal(w1b.externalId)).toBeUndefined()

    expect(getByPaneId('p-multi-2a')).toBe(w2a)
    expect(resolveExternal(w2a.externalId)).toBe(w2a)
  })
})
