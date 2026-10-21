import { describe, expect, it } from 'vitest'
import {
  appBundleOf,
  detectInstallMethod,
  type InstallProbe,
  replaceableAppDir,
  seededInstallMethod,
} from './installMethod'

const HOME = '/home/u'

function probe(over: Partial<InstallProbe>, present: string[] = []): InstallProbe {
  return {
    execPath: '/somewhere/ostia-1.0.0-linux-x64/ostia',
    platform: 'linux',
    isPackaged: true,
    env: {},
    home: HOME,
    exists: (path) => present.includes(path),
    ...over,
  }
}

describe('detectInstallMethod', () => {
  it('is dev for an unpackaged build wherever it runs', () => {
    expect(detectInstallMethod(probe({ isPackaged: false, execPath: '/opt/ostia/ostia' }))).toBe(
      'dev',
    )
  })

  it('is apt when the binary is under /opt/ostia and dpkg lists the package', () => {
    const p = probe({ execPath: '/opt/ostia/ostia' }, ['/var/lib/dpkg/info/ostia.list'])
    expect(detectInstallMethod(p)).toBe('apt')
  })

  it('is tarball under /opt/ostia without the dpkg list', () => {
    expect(detectInstallMethod(probe({ execPath: '/opt/ostia/ostia' }))).toBe('tarball')
  })

  it('is local under XDG_DATA_HOME or ~/.local/share', () => {
    expect(detectInstallMethod(probe({ execPath: `${HOME}/.local/share/ostia/app/ostia` }))).toBe(
      'local',
    )
    expect(
      detectInstallMethod(
        probe({ execPath: '/data/ostia/app/ostia', env: { XDG_DATA_HOME: '/data' } }),
      ),
    ).toBe('local')
  })

  it('is tarball for any other packaged Linux path', () => {
    expect(detectInstallMethod(probe({ execPath: `${HOME}/Downloads/ostia-x/ostia` }))).toBe(
      'tarball',
    )
    expect(
      detectInstallMethod(probe({ execPath: `${HOME}/.local/share/ostia/app-old/ostia` })),
    ).toBe('tarball')
  })

  it('is brew on macOS for an .app with a cask receipt, else dmg', () => {
    const exec = '/Applications/Ostia.app/Contents/MacOS/Ostia'
    expect(
      detectInstallMethod(
        probe({ platform: 'darwin', execPath: exec }, ['/opt/homebrew/Caskroom/ostia']),
      ),
    ).toBe('brew')
    expect(
      detectInstallMethod(
        probe({ platform: 'darwin', execPath: exec, env: { HOMEBREW_PREFIX: '/brew' } }, [
          '/brew/Caskroom/ostia',
        ]),
      ),
    ).toBe('brew')
    expect(
      detectInstallMethod(
        probe({ platform: 'darwin', execPath: exec, env: { HOMEBREW_PREFIX: '/brew' } }, [
          '/opt/homebrew/Caskroom/ostia',
        ]),
      ),
    ).toBe('dmg')
    expect(detectInstallMethod(probe({ platform: 'darwin', execPath: exec }))).toBe('dmg')
  })
})

describe('seededInstallMethod', () => {
  it('honours OSTIA_INSTALL_METHOD only when unpackaged and only for a known name', () => {
    expect(seededInstallMethod(false, { OSTIA_INSTALL_METHOD: 'apt' })).toBe('apt')
    expect(seededInstallMethod(true, { OSTIA_INSTALL_METHOD: 'apt' })).toBeNull()
    expect(seededInstallMethod(false, { OSTIA_INSTALL_METHOD: 'snap' })).toBeNull()
    expect(seededInstallMethod(false, {})).toBeNull()
  })
})

describe('replaceableAppDir', () => {
  const execPath = '/home/u/.local/share/ostia/app/ostia'

  it('is the folder of the running binary for local and tarball installs', () => {
    for (const method of ['local', 'tarball'] as const) {
      expect(replaceableAppDir({ method, isPackaged: true, execPath, env: {} })).toBe(
        '/home/u/.local/share/ostia/app',
      )
    }
  })

  it('is the app bundle of the running binary for brew and dmg installs', () => {
    const bundle = '/Applications/Ostia Beta.app'
    for (const method of ['brew', 'dmg'] as const) {
      expect(
        replaceableAppDir({
          method,
          isPackaged: true,
          execPath: `${bundle}/Contents/MacOS/Ostia`,
          env: {},
        }),
      ).toBe(bundle)
      expect(
        replaceableAppDir({ method, isPackaged: true, execPath: '/usr/bin/ostia', env: {} }),
      ).toBeNull()
    }
    expect(appBundleOf('/Applications/Ostia.app/Contents/MacOS/Ostia')).toBe(
      '/Applications/Ostia.app',
    )
    expect(appBundleOf('/Applications/Ostia.app/Contents/Frameworks/x')).toBeNull()
  })

  it('is null for an apt install or a dev build without the env', () => {
    for (const method of ['apt', 'dev'] as const) {
      expect(replaceableAppDir({ method, isPackaged: true, execPath, env: {} })).toBeNull()
    }
    expect(
      replaceableAppDir({ method: 'tarball', isPackaged: false, execPath, env: {} }),
    ).toBeNull()
  })

  it('takes OSTIA_INSTALL_APP_DIR only when unpackaged', () => {
    const env = { OSTIA_INSTALL_APP_DIR: '/tmp/app' }
    expect(replaceableAppDir({ method: 'tarball', isPackaged: false, execPath, env })).toBe(
      '/tmp/app',
    )
    expect(replaceableAppDir({ method: 'tarball', isPackaged: true, execPath, env })).toBe(
      '/home/u/.local/share/ostia/app',
    )
  })
})
