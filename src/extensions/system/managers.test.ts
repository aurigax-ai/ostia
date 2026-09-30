import { describe, expect, it } from 'vitest'
import { defaultManager, findOnPath, installArgv, invalidPackages } from './managers'
import type { OsIdentity } from './os'

const linux = (id: string, idLike: string[] = []): OsIdentity => ({
  platform: 'linux',
  id,
  idLike,
  name: id,
  version: '',
})

describe('defaultManager', () => {
  it('picks pacman on Arch-family systems even when an AUR helper is present', () => {
    expect(defaultManager(linux('cachyos'), ['paru', 'pacman', 'flatpak'])).toBe('pacman')
    expect(defaultManager(linux('arch'), ['yay', 'pacman'])).toBe('pacman')
  })

  it('follows ID_LIKE for derivatives it does not know by name', () => {
    expect(defaultManager(linux('zorin', ['ubuntu', 'debian']), ['apt', 'snap'])).toBe('apt')
    expect(defaultManager(linux('nobara', ['fedora']), ['dnf', 'flatpak'])).toBe('dnf')
    expect(defaultManager(linux('opensuse-tumbleweed', ['opensuse', 'suse']), ['zypper'])).toBe(
      'zypper',
    )
  })

  it('picks brew on macOS and winget on Windows', () => {
    const mac: OsIdentity = { platform: 'darwin', id: 'macos', idLike: [], name: '', version: '' }
    const win: OsIdentity = { platform: 'win32', id: 'windows', idLike: [], name: '', version: '' }
    expect(defaultManager(mac, ['brew', 'nix-env'])).toBe('brew')
    expect(defaultManager(win, ['winget'])).toBe('winget')
  })

  it('falls back to an available system manager, never an app store or AUR helper', () => {
    expect(defaultManager(linux('fedora'), ['brew', 'flatpak'])).toBe('brew')
    expect(defaultManager(linux('mystery'), ['flatpak', 'snap', 'paru'])).toBeNull()
    expect(defaultManager(linux('debian'), [])).toBeNull()
  })
})

describe('installArgv', () => {
  it('prefixes sudo for root managers unless already root', () => {
    expect(installArgv('pacman', ['ripgrep', 'fd'], { isRoot: false })).toEqual({
      ok: true,
      argv: ['sudo', 'pacman', '-S', '--needed', 'ripgrep', 'fd'],
    })
    expect(installArgv('apt', ['ripgrep'], { isRoot: true })).toEqual({
      ok: true,
      argv: ['apt', 'install', 'ripgrep'],
    })
    expect(installArgv('apk', ['ripgrep'], { isRoot: false })).toEqual({
      ok: true,
      argv: ['sudo', 'apk', 'add', 'ripgrep'],
    })
  })

  it('never runs brew or an AUR helper under sudo', () => {
    expect(installArgv('brew', ['ripgrep'], { isRoot: false })).toEqual({
      ok: true,
      argv: ['brew', 'install', 'ripgrep'],
    })
    expect(installArgv('paru', ['yay-bin'], { isRoot: false })).toEqual({
      ok: true,
      argv: ['paru', '-S', '--needed', 'yay-bin'],
    })
  })

  it('installs one exact id at a time with winget', () => {
    expect(installArgv('winget', ['BurntSushi.ripgrep.MSVC'], { isRoot: false })).toEqual({
      ok: true,
      argv: ['winget', 'install', '--exact', '--id', 'BurntSushi.ripgrep.MSVC'],
    })
    expect(installArgv('winget', ['a', 'b'], { isRoot: false })).toEqual({
      ok: false,
      error: 'one-package-only',
    })
  })
})

describe('invalidPackages', () => {
  it('accepts real package names across managers', () => {
    expect(
      invalidPackages([
        'ripgrep',
        'libssl-dev:amd64',
        'g++',
        'python3.12',
        'nixpkgs.ripgrep',
        'org.gnome.Calculator',
        'node@20',
      ]),
    ).toEqual([])
  })

  it('rejects flags, paths, shell syntax and whitespace', () => {
    const bad = ['-rf', '--noconfirm', './evil.deb', '/tmp/x', 'a;b', '$(id)', 'a b', '', 'a/b']
    expect(invalidPackages(bad)).toEqual(bad)
    expect(invalidPackages(['x'.repeat(129)])).toHaveLength(1)
  })
})

describe('findOnPath', () => {
  it('returns the first executable match in PATH order', () => {
    const exe = new Set(['/usr/bin/pacman', '/opt/bin/pacman'])
    const env = { path: '/opt/bin:/usr/bin', platform: 'linux' }
    expect(findOnPath('pacman', env, (f) => exe.has(f))).toBe('/opt/bin/pacman')
    expect(findOnPath('apt', env, (f) => exe.has(f))).toBeNull()
  })

  it('tries PATHEXT suffixes on Windows', () => {
    const env = { path: 'C:\\Tools;C:\\Win\\', platform: 'win32', pathExt: '.EXE;.CMD' }
    const exe = new Set(['C:\\Win\\winget.exe'])
    expect(findOnPath('winget', env, (f) => exe.has(f))).toBe('C:\\Win\\winget.exe')
  })
})
