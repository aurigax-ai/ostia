import { describe, expect, it } from 'vitest'
import { type InstallContext, parseInstallArgs, planInstall } from './install'
import { stringsFor } from './strings'

const s = stringsFor('en')

const arch: InstallContext = {
  os: { platform: 'linux', id: 'cachyos', idLike: [], name: 'CachyOS', version: 'rolling' },
  available: ['pacman', 'paru', 'flatpak'],
  isRoot: false,
  hasSudo: true,
}

describe('parseInstallArgs', () => {
  it('separates packages from --manager and --reason in any order', () => {
    expect(
      parseInstallArgs(['ripgrep', '--reason', 'search the repo', 'fd', '--manager', 'paru']),
    ).toEqual({ packages: ['ripgrep', 'fd'], manager: 'paru', reason: 'search the repo' })
  })

  it('keeps a dangling flag as a package so validation rejects it', () => {
    expect(parseInstallArgs(['ripgrep', '--manager'])).toEqual({
      packages: ['ripgrep', '--manager'],
    })
  })
})

describe('planInstall', () => {
  it('plans the default manager with sudo and the exact shell line the human sees', () => {
    const res = planInstall({ packages: ['ripgrep', 'fd'], reason: '  grep faster ' }, arch, s)
    expect(res).toEqual({
      ok: true,
      plan: {
        manager: 'pacman',
        packages: ['ripgrep', 'fd'],
        argv: ['sudo', 'pacman', '-S', '--needed', 'ripgrep', 'fd'],
        command: 'sudo pacman -S --needed ripgrep fd',
        reason: 'grep faster',
      },
    })
  })

  it('uses a requested manager that is on PATH', () => {
    const res = planInstall({ packages: ['yay-bin'], manager: 'paru' }, arch, s)
    expect(res.ok && res.plan.command).toBe('paru -S --needed yay-bin')
  })

  it('refuses before asking anyone when a name looks like a flag or shell syntax', () => {
    expect(planInstall({ packages: ['ripgrep', '--noconfirm'] }, arch, s)).toMatchObject({
      ok: false,
      error: 'invalid-package',
    })
    expect(planInstall({ packages: ['a;reboot'] }, arch, s)).toMatchObject({
      ok: false,
      error: 'invalid-package',
    })
    expect(planInstall({ packages: [] }, arch, s)).toMatchObject({
      ok: false,
      error: 'invalid-args',
    })
  })

  it('refuses unknown managers and ones that are not installed', () => {
    expect(planInstall({ packages: ['x'], manager: 'pip' }, arch, s)).toMatchObject({
      ok: false,
      error: 'unknown-manager',
    })
    expect(planInstall({ packages: ['x'], manager: 'apt' }, arch, s)).toMatchObject({
      ok: false,
      error: 'manager-missing',
    })
  })

  it('reports when there is no manager or no sudo to run it with', () => {
    expect(planInstall({ packages: ['x'] }, { ...arch, available: ['flatpak'] }, s)).toMatchObject({
      ok: false,
      error: 'no-manager',
    })
    expect(planInstall({ packages: ['x'] }, { ...arch, hasSudo: false }, s)).toMatchObject({
      ok: false,
      error: 'no-sudo',
    })
    const root = planInstall({ packages: ['x'] }, { ...arch, hasSudo: false, isRoot: true }, s)
    expect(root.ok && root.plan.command).toBe('pacman -S --needed x')
  })
})
