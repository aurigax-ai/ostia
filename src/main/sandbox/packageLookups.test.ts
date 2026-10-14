import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PackageRef } from '../../shared/sandbox/packages'
import { cachedLookups } from './packageLookups'

function requestedUrl(pkg: PackageRef): Promise<string> {
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  return cachedLookups()
    .publishedAt(pkg)
    .then(() => String((fetch.mock.calls[0] as unknown[])[0]))
}

describe('sandbox/packageLookups', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks the npm registry for a name the way the npm client escapes it', async () => {
    expect(await requestedUrl({ ecosystem: 'npm', name: '@types/node', version: '1.0.0' })).toBe(
      'https://registry.npmjs.org/@types%2fnode',
    )
    expect(await requestedUrl({ ecosystem: 'npm', name: 'left-pad', version: '1.0.0' })).toBe(
      'https://registry.npmjs.org/left-pad',
    )
  })

  it('keeps a name or version that carries URL syntax inside its own path segment', async () => {
    expect(await requestedUrl({ ecosystem: 'npm', name: '@a/b#c', version: '1.0.0' })).toBe(
      'https://registry.npmjs.org/@a%2fb%23c',
    )
    expect(await requestedUrl({ ecosystem: 'PyPI', name: 'demo', version: '1.0?x=1#y' })).toBe(
      'https://pypi.org/pypi/demo/1.0%3Fx%3D1%23y/json',
    )
    expect(
      await requestedUrl({ ecosystem: 'crates.io', name: 'demo/../x', version: '1.0.0' }),
    ).toBe('https://crates.io/api/v1/crates/demo%2F..%2Fx/1.0.0')
    expect(
      await requestedUrl({ ecosystem: 'Go', name: 'github.com/BurntSushi/to#ml', version: 'v1?x' }),
    ).toBe('https://proxy.golang.org/github.com/!burnt!sushi/to%23ml/@v/v1%3Fx.info')
  })
})
