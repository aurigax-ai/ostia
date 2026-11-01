import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { insideRealHome } from '../../../test/realHome'
import { privateRunDir, privateTmpDir, socketPath } from './privateTmp'

describe('privateTmpDir', () => {
  it('creates a per-user directory only the owner can access', () => {
    const dir = privateTmpDir(`ostia-test-${process.pid}`)
    const st = statSync(dir)
    expect(st.isDirectory()).toBe(true)
    if (process.platform !== 'win32') {
      expect(dir.endsWith(`-${process.getuid?.()}`)).toBe(true)
      expect(st.mode & 0o077).toBe(0)
    }
  })

  it('is idempotent', () => {
    const name = `ostia-test-idem-${process.pid}`
    expect(privateTmpDir(name)).toBe(privateTmpDir(name))
  })
})

describe('privateRunDir', () => {
  it('resolves outside the real home folder while tests run', () => {
    expect(insideRealHome(privateRunDir('isolation-check'))).toBe(false)
  })

  it('is a private folder in the app data folder on macOS, which dirhelper does not clean', () => {
    const home = mkdtempSync(join(tmpdir(), 'run-home-'))
    try {
      const dir = privateRunDir('shell-integration', 'darwin', {}, home)
      expect(dir).toBe(join(home, '.local', 'share', 'ostia', 'run', 'shell-integration'))
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(privateRunDir('kept', 'darwin', { XDG_DATA_HOME: join(home, 'd') }, home)).toBe(
        join(home, 'd', 'ostia', 'run', 'kept'),
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('throws on macOS when the app data folder cannot hold the run folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'run-home-'))
    try {
      mkdirSync(join(home, 'd', 'ostia'), { recursive: true })
      writeFileSync(join(home, 'd', 'ostia', 'run'), '')
      expect(() =>
        privateRunDir('kept', 'darwin', { XDG_DATA_HOME: join(home, 'd') }, home),
      ).toThrow()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('stays in the private temp folder on Linux', () => {
    expect(privateRunDir('shell-integration', 'linux')).toBe(
      privateTmpDir('ostia-shell-integration'),
    )
  })
})

describe('socketPath', () => {
  const longDir = `/private/var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/ostia-sbx-501/12345/ws-abcdef-12/${'x'.repeat(20)}`

  it('keeps a path that fits where it was asked for', () => {
    expect(socketPath('/tmp/a', 'ostia-1.sock', 'darwin')).toBe('/tmp/a/ostia-1.sock')
  })

  it('moves a path past the macOS limit to a short owned folder', () => {
    const path = socketPath(longDir, 'agent.sock', 'darwin')
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103)
    expect(path.endsWith('.sock')).toBe(true)
    const st = statSync(dirname(path))
    expect(st.mode & 0o077).toBe(0)
  })

  it('gives different long paths different short names and the same path the same one', () => {
    const a = socketPath(longDir, 'a.sock', 'darwin')
    expect(socketPath(longDir, 'a.sock', 'darwin')).toBe(a)
    expect(socketPath(longDir, 'b.sock', 'darwin')).not.toBe(a)
  })

  it('leaves a Linux path alone until it passes 107 bytes', () => {
    const fits = `/run/user/1000/${'x'.repeat(80)}.sock`
    expect(socketPath('/run/user/1000', `${'x'.repeat(80)}.sock`, 'linux')).toBe(fits)
    expect(Buffer.byteLength(socketPath(longDir, 'agent.sock', 'linux'))).toBeLessThanOrEqual(107)
  })
})
