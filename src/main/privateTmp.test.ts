import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { privateTmpDir, socketPath } from './privateTmp'

describe('privateTmpDir', () => {
  it('creates a per-user directory only the owner can access', () => {
    const dir = privateTmpDir(`pine-test-${process.pid}`)
    const st = statSync(dir)
    expect(st.isDirectory()).toBe(true)
    if (process.platform !== 'win32') {
      expect(dir.endsWith(`-${process.getuid?.()}`)).toBe(true)
      expect(st.mode & 0o077).toBe(0)
    }
  })

  it('is idempotent', () => {
    const name = `pine-test-idem-${process.pid}`
    expect(privateTmpDir(name)).toBe(privateTmpDir(name))
  })
})

describe('socketPath', () => {
  const longDir = `/private/var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/ostia-sbx-501/12345/ws-abcdef-12/${'x'.repeat(20)}`

  it('keeps a path that fits where it was asked for', () => {
    expect(socketPath('/tmp/a', 'pine-1.sock', 'darwin')).toBe('/tmp/a/pine-1.sock')
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
