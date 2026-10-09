import { describe, expect, it } from 'vitest'
import { parsePackageDownload } from '../../shared/sandbox/packages'
import { type PackageLookups, decidePackage } from './packagePolicy'

const NOW = Date.parse('2026-09-30T12:00:00Z')
const HOUR = 3600_000
const DAY = 24 * HOUR

function lookups(overrides: Partial<PackageLookups> = {}): PackageLookups {
  return {
    malware: async () => 'clean',
    publishedAt: async () => NOW - 400 * DAY,
    ...overrides,
  }
}

const POLICY = { malware: true, cooldownDays: 2, denyList: [], allowOnly: null, allowances: [] }

describe('parsePackageDownload', () => {
  it('reads ecosystem, name and version from registry download URLs', () => {
    expect(
      parsePackageDownload('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'),
    ).toEqual({ ecosystem: 'npm', name: 'left-pad', version: '1.3.0' })
    expect(
      parsePackageDownload('https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0-beta.1.tgz'),
    ).toEqual({ ecosystem: 'npm', name: '@scope/pkg', version: '2.0.0-beta.1' })
    expect(
      parsePackageDownload(
        'https://files.pythonhosted.org/packages/ab/cd/ef/requests-2.32.3-py3-none-any.whl',
      ),
    ).toEqual({ ecosystem: 'PyPI', name: 'requests', version: '2.32.3' })
    expect(
      parsePackageDownload(
        'https://files.pythonhosted.org/packages/ab/cd/ef/evil_pkg-1.0.0.tar.gz',
      ),
    ).toEqual({ ecosystem: 'PyPI', name: 'evil-pkg', version: '1.0.0' })
    expect(
      parsePackageDownload('https://static.crates.io/crates/serde/serde-1.0.200.crate'),
    ).toEqual({ ecosystem: 'crates.io', name: 'serde', version: '1.0.200' })
    expect(
      parsePackageDownload('https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.3.2.zip'),
    ).toEqual({ ecosystem: 'Go', name: 'github.com/BurntSushi/toml', version: 'v1.3.2' })
    expect(parsePackageDownload('https://registry.npmjs.org/left-pad')).toBeNull()
    expect(parsePackageDownload('https://example.com/left-pad-1.0.0.tgz')).toBeNull()
  })
})

describe('decidePackage', () => {
  const pkg = { ecosystem: 'npm' as const, name: 'fresh-pkg', version: '1.0.0' }

  it('SBX-C81 denies a version younger than the cooldown', async () => {
    const decision = await decidePackage(
      pkg,
      POLICY,
      lookups({ publishedAt: async () => NOW - HOUR }),
      NOW,
    )
    expect(decision).toEqual({ allow: false, reason: 'cooldown' })
  })

  it('SBX-C82 denies a version with a malware record', async () => {
    const decision = await decidePackage(
      { ecosystem: 'PyPI', name: 'evil-pkg', version: '1.0.0' },
      POLICY,
      lookups({ malware: async () => 'malicious' }),
      NOW,
    )
    expect(decision).toEqual({ allow: false, reason: 'malware' })
  })

  it('SBX-C83 denies when OSV cannot be reached', async () => {
    const decision = await decidePackage(
      pkg,
      POLICY,
      lookups({ malware: async () => 'unavailable' }),
      NOW,
    )
    expect(decision).toEqual({ allow: false, reason: 'osv-unavailable' })
  })

  it('honours the deny list, the allow-only list and allowances', async () => {
    const old = lookups()
    expect(await decidePackage(pkg, { ...POLICY, denyList: ['npm:fresh-pkg'] }, old, NOW)).toEqual({
      allow: false,
      reason: 'deny-list',
    })
    expect(await decidePackage(pkg, { ...POLICY, allowOnly: ['npm:other'] }, old, NOW)).toEqual({
      allow: false,
      reason: 'not-allowed',
    })
    expect(
      await decidePackage(
        pkg,
        { ...POLICY, allowances: ['npm:fresh-pkg@1.0.0'] },
        lookups({ publishedAt: async () => NOW - HOUR }),
        NOW,
      ),
    ).toEqual({ allow: true })
  })
})
