import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planConnect, withShellIntegration } from './plan'
import { transferArgs } from './remote/transfer'
import { controlDirFor, prepareControlDir, sharingOptions, useControlDir } from './share'

const uid = process.getuid?.() ?? 0

afterEach(() => useControlDir(null))

describe('controlDirFor', () => {
  it('SHR-U1 uses the runtime dir when there is one and a short per-user dir in /tmp otherwise', () => {
    expect(controlDirFor('linux', { XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toBe(
      '/run/user/1000/ostia-ssh',
    )
    expect(controlDirFor('darwin', {}, 501)).toBe('/tmp/ostia-ssh-501')
  })

  it('SHR-U2 turns sharing off on Windows', () => {
    expect(controlDirFor('win32', {}, undefined)).toBeNull()
  })
})

describe('prepareControlDir', () => {
  const roots: string[] = []
  const root = (): string => {
    const dir = mkdtempSync('/tmp/os-')
    roots.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('SHR-U3 creates the folder private to the user and accepts it again', () => {
    const dir = join(root(), 's')
    expect(prepareControlDir(dir, uid)).toBe(dir)
    expect(prepareControlDir(dir, uid)).toBe(dir)
  })

  it('SHR-U4 refuses a folder others can enter, a link, and an owner that is not the user', () => {
    const base = root()
    const open = join(base, 'open')
    mkdirSync(open, { mode: 0o755 })
    expect(prepareControlDir(open, uid)).toBeNull()
    const real = join(base, 'real')
    mkdirSync(real, { mode: 0o700 })
    const link = join(base, 'link')
    symlinkSync(real, link)
    expect(prepareControlDir(link, uid)).toBeNull()
    expect(prepareControlDir(real, uid + 1)).toBeNull()
  })

  it('SHR-U5 refuses a path that is too long for a socket or has characters ssh would expand', () => {
    expect(prepareControlDir(`/tmp/${'a'.repeat(60)}`, uid)).toBeNull()
    expect(prepareControlDir('/tmp/ostia %h', uid)).toBeNull()
    expect(prepareControlDir(null, uid)).toBeNull()
  })
})

describe('shared connection options', () => {
  it('SHR-U6 changes no argv while sharing is off', () => {
    expect(sharingOptions()).toEqual([])
    expect(planConnect(['box'])?.argv).toEqual(['ssh', '--', 'box'])
  })

  it('SHR-U7 puts the same master options before the separator of every plan, and of the git transport', () => {
    useControlDir('/run/user/1000/ostia-ssh')
    const plain = planConnect(['-p', '2200', 'box'])
    if (!plain) throw new Error('planned')
    const options = [
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPath=/run/user/1000/ostia-ssh/%C',
      '-o',
      'ControlPersist=10m',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
    ]
    expect(plain.argv).toEqual(['ssh', '-p', '2200', ...options, '--', 'box'])
    expect(withShellIntegration(plain).argv.slice(0, -1)).toEqual([
      'ssh',
      '-p',
      '2200',
      ...options,
      '-t',
      '--',
      'box',
    ])
    expect(transferArgs(plain).at(-1)).toContain('ControlPath=/run/user/1000/ostia-ssh/%C')
  })
})
