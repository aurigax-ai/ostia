import { afterEach, describe, expect, it } from 'vitest'
import { mountSurface, parkSurface, releaseSurfaces, surfaceHost } from './surfaceSlotsStore'

const div = () => document.createElement('div')

describe('surfaceSlotsStore', () => {
  afterEach(() => releaseSurfaces(new Set()))

  it('returns the same host element for a pane on every call', () => {
    expect(surfaceHost('pane-1')).toBe(surfaceHost('pane-1'))
    expect(surfaceHost('pane-1')).not.toBe(surfaceHost('pane-2'))
  })

  it('mountSurface re-parents the same host into each new slot', () => {
    const host = surfaceHost('pane-1')
    const a = div()
    const b = div()
    mountSurface('pane-1', a)
    expect(host.parentNode).toBe(a)
    mountSurface('pane-1', b)
    expect(host.parentNode).toBe(b)
    expect(a.childNodes).toHaveLength(0)
  })

  it('parkSurface moves the host out of its slot into a detached holder', () => {
    const slot = div()
    mountSurface('pane-1', slot)
    parkSurface('pane-1', slot)
    const host = surfaceHost('pane-1')
    expect(host.parentNode).not.toBe(slot)
    expect(host.parentNode).not.toBeNull()
    expect(host.isConnected).toBe(false)
  })

  it('parkSurface from a stale slot does not steal the host from its newer slot', () => {
    const old = div()
    const next = div()
    mountSurface('pane-1', old)
    mountSurface('pane-1', next)
    parkSurface('pane-1', old)
    expect(surfaceHost('pane-1').parentNode).toBe(next)
  })

  it('releaseSurfaces removes hosts of dead panes and keeps live ones', () => {
    const slot = div()
    const live = surfaceHost('pane-live')
    const dead = surfaceHost('pane-dead')
    mountSurface('pane-dead', slot)
    releaseSurfaces(new Set(['pane-live']))
    expect(slot.childNodes).toHaveLength(0)
    expect(surfaceHost('pane-live')).toBe(live)
    expect(surfaceHost('pane-dead')).not.toBe(dead)
  })
})
