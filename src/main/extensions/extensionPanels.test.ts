import { describe, expect, it } from 'vitest'
import { ExtensionPanels, type ExtensionPanelsHost, loopbackOrigin } from './extensionPanels'
import type { Runtime } from './extensionRuntime'

describe('loopbackOrigin', () => {
  it('accepts only plain-http loopback URLs', () => {
    expect(loopbackOrigin('http://127.0.0.1:4000/x?t=1')).toBe('http://127.0.0.1:4000')
    expect(loopbackOrigin('http://localhost:4000/')).toBe('http://localhost:4000')
    expect(loopbackOrigin('https://127.0.0.1:4000/')).toBeNull()
    expect(loopbackOrigin('http://192.168.1.2:4000/')).toBeNull()
    expect(loopbackOrigin('http://127.0.0.1.evil.com/')).toBeNull()
    expect(loopbackOrigin('file:///etc/passwd')).toBeNull()
    expect(loopbackOrigin('garbage')).toBeNull()
  })
})

describe('ExtensionPanels view kinds', () => {
  const kinds = [
    {
      id: 'acme.grid',
      displayName: 'Grid',
      selector: [{ filenamePattern: '*.grid' }],
      view: { entry: 'grid.html', priority: 'default' },
    },
  ]
  const runtime = {
    ext: { dir: '/ext/acme', manifest: { id: 'acme', contributes: { fileKinds: kinds } } },
  } as unknown as Runtime

  function panels(approved: boolean, active = true): ExtensionPanels {
    return new ExtensionPanels({
      deps: {},
      runtimes: new Map([['acme', runtime]]),
      active: () => active,
      kindApproved: () => approved,
    } as unknown as ExtensionPanelsHost)
  }

  it('serves the view of an approved kind for a matching file only', () => {
    expect(panels(true).viewSource('acme', 'acme.grid', '/w/a.grid')).toEqual({
      dir: '/ext/acme',
      entry: 'grid.html',
    })
    expect(panels(true).viewSource('acme', 'acme.grid', '/w/a.txt')).toBeNull()
    expect(panels(true).viewSource('acme', 'acme.other', '/w/a.grid')).toBeNull()
    expect(panels(true).hasViewKind('/w/a.grid')).toBe(true)
  })

  it('refuses a forged open of a kind the human has not approved', () => {
    expect(panels(false).viewSource('acme', 'acme.grid', '/w/a.grid')).toBeNull()
    expect(panels(false).hasViewKind('/w/a.grid')).toBe(false)
  })

  it('refuses a kind of an extension that is not active', () => {
    expect(panels(true, false).viewSource('acme', 'acme.grid', '/w/a.grid')).toBeNull()
    expect(panels(true, false).hasViewKind('/w/a.grid')).toBe(false)
  })
})
