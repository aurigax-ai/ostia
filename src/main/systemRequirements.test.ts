import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  SANDBOX_FEATURE,
  installHint,
  missingRequirements,
  registerRequirements,
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
    expect(missingRequirements(SANDBOX_FEATURE, { platform: 'linux', path: some })).toEqual([
      { program: 'bwrap', package: 'bubblewrap' },
      { program: 'rg', package: 'ripgrep' },
    ])
    const all = binDir('all', ['socat', 'bwrap', 'rg'])
    expect(missingRequirements(SANDBOX_FEATURE, { platform: 'linux', path: all })).toEqual([])
    expect(missingRequirements(SANDBOX_FEATURE, { platform: 'darwin', path: some })).toEqual([
      { program: 'rg', package: 'ripgrep' },
    ])
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
