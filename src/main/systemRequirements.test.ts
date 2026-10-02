import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MANAGER_FEATURE } from '../shared/managerSettings'
import {
  SANDBOX_FEATURE,
  installHint,
  missingRequirements,
  programPath,
  registerRequirements,
  requirementLabel,
} from './systemRequirements'

const root = mkdtempSync(join(tmpdir(), 'pine-reqs-'))

afterAll(() => rmSync(root, { recursive: true, force: true }))

function binDir(name: string, programs: string[]): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const program of programs) {
    writeFileSync(join(dir, program), '#!/bin/sh\n')
    chmodSync(join(dir, program), 0o755)
  }
  return dir
}

describe('systemRequirements', () => {
  it('names the sandbox packages missing on Linux and nothing when all are there', () => {
    const some = binDir('some', ['socat'])
    const direct = { platform: 'linux' as const, ptyRelay: false }
    expect(missingRequirements(SANDBOX_FEATURE, { ...direct, path: some })).toEqual([
      { program: 'bwrap', package: 'bubblewrap' },
      { program: 'rg', package: 'ripgrep' },
    ])
    const all = binDir('all', ['socat', 'bwrap', 'rg'])
    expect(missingRequirements(SANDBOX_FEATURE, { ...direct, path: all })).toEqual([])
    expect(missingRequirements(SANDBOX_FEATURE, { platform: 'darwin', path: some })).toEqual([
      { program: 'rg', package: 'ripgrep' },
    ])
  })

  it('needs script from util-linux only where the sandboxed shell runs behind the pty relay', () => {
    const all = binDir('no-script', ['socat', 'bwrap', 'rg'])
    const env = { platform: 'linux' as const, path: all }
    expect(missingRequirements(SANDBOX_FEATURE, { ...env, ptyRelay: false })).toEqual([])
    expect(missingRequirements(SANDBOX_FEATURE, { ...env, ptyRelay: true })).toEqual([
      { program: 'script', package: 'util-linux' },
    ])
  })

  it('MGR-C39 the manager needs ss from iproute2 on Linux only', () => {
    const none = binDir('none', [])
    expect(missingRequirements(MANAGER_FEATURE, { platform: 'linux', path: none })).toEqual([
      { program: 'ss', package: 'iproute2' },
    ])
    const withSs = binDir('with-ss', ['ss'])
    expect(missingRequirements(MANAGER_FEATURE, { platform: 'linux', path: withSs })).toEqual([])
    expect(missingRequirements(MANAGER_FEATURE, { platform: 'darwin', path: none })).toEqual([])
  })

  it('treats an unknown feature and a non-executable file as missing nothing and missing', () => {
    expect(missingRequirements('no-such-feature', { platform: 'linux', path: '' })).toEqual([])
    const dir = join(root, 'noexec')
    mkdirSync(dir)
    writeFileSync(join(dir, 'tool'), '')
    registerRequirements('noexec-feature', [
      { program: 'tool', package: 'tool-pkg', platforms: ['linux'] },
    ])
    expect(missingRequirements('noexec-feature', { platform: 'linux', path: dir })).toEqual([
      { program: 'tool', package: 'tool-pkg' },
    ])
  })

  it('finds a program’s absolute path on PATH, names a feature for the human, and forgets one', () => {
    const dir = binDir('lsp-bin', ['gopls'])
    expect(programPath('gopls', `/nonexistent:${dir}`)).toBe(join(dir, 'gopls'))
    expect(programPath('gopls', '/nonexistent')).toBeNull()
    registerRequirements(
      'lsp:lsp-gopls/gopls',
      [{ program: 'gopls', package: 'gopls', platforms: ['linux'] }],
      'gopls',
    )
    expect(requirementLabel('lsp:lsp-gopls/gopls')).toBe('gopls')
    expect(requirementLabel('sandbox')).toBe('sandbox')
    expect(
      missingRequirements('lsp:lsp-gopls/gopls', { platform: 'linux', path: '/nonexistent' }),
    ).toEqual([{ program: 'gopls', package: 'gopls' }])
    registerRequirements('lsp:lsp-gopls/gopls', [])
    expect(
      missingRequirements('lsp:lsp-gopls/gopls', { platform: 'linux', path: '/nonexistent' }),
    ).toEqual([])
    expect(requirementLabel('lsp:lsp-gopls/gopls')).toBe('lsp:lsp-gopls/gopls')
  })

  it('SBX-C98 builds a copyable install command for the package manager on PATH', () => {
    const missing = [
      { program: 'bwrap', package: 'bubblewrap' },
      { program: 'socat', package: 'socat' },
    ]
    const pacman = binDir('pacman-bin', ['pacman', 'sudo'])
    expect(installHint(missing, { platform: 'linux', path: pacman })).toEqual({
      command: 'sudo pacman -S --needed bubblewrap socat',
      packages: ['bubblewrap', 'socat'],
    })
    const apt = binDir('apt-bin', ['apt-get'])
    expect(installHint(missing, { platform: 'linux', path: apt }).command).toBe(
      'sudo apt-get install bubblewrap socat',
    )
    expect(installHint(missing, { platform: 'linux', path: '' })).toEqual({
      command: null,
      packages: ['bubblewrap', 'socat'],
    })
  })
})
