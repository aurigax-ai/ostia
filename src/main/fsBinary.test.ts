import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { FS_BINARY_MAX, readBinaryConfined } from './fsBinary'

let root: string
let outside: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pine-fsbin-root-'))
  outside = mkdtempSync(join(tmpdir(), 'pine-fsbin-out-'))
  writeFileSync(join(root, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]))
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(64))
  writeFileSync(join(outside, 'secret.bin'), Buffer.from('secret'))
  mkdirSync(join(root, 'dir'))
})

describe('readBinaryConfined', () => {
  it('returns the exact bytes of a file inside an allowed root', () => {
    const res = readBinaryConfined(join(root, 'pixel.png'), [root])
    expect(res.ok).toBe(true)
    if (res.ok) expect([...res.data]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])
  })

  it('refuses a path outside every allowed root', () => {
    expect(readBinaryConfined(join(outside, 'secret.bin'), [root])).toEqual({
      ok: false,
      error: 'denied',
    })
  })

  it('refuses a ../ escape out of the root', () => {
    const escaped = `${root}/../${basename(outside)}/secret.bin`
    expect(readBinaryConfined(escaped, [root])).toEqual({ ok: false, error: 'denied' })
  })

  it('refuses a non-string path', () => {
    expect(readBinaryConfined(42, [root])).toEqual({ ok: false, error: 'denied' })
  })

  it('reports a file over the size cap without returning its bytes', () => {
    expect(readBinaryConfined(join(root, 'big.bin'), [root], 32)).toEqual({
      ok: false,
      error: 'too-large',
      size: 64,
    })
  })

  it('caps reads at 50 MiB by default', () => {
    expect(FS_BINARY_MAX).toBe(50 * 1024 * 1024)
  })

  it('reports directories and missing files as unreadable', () => {
    expect(readBinaryConfined(join(root, 'dir'), [root])).toEqual({
      ok: false,
      error: 'unreadable',
    })
    expect(readBinaryConfined(join(root, 'nope.png'), [root])).toEqual({
      ok: false,
      error: 'unreadable',
    })
  })

  it('follows a symlink inside the root, as the lexical fs guard documents', () => {
    symlinkSync(join(root, 'pixel.png'), join(root, 'link.png'))
    expect(readBinaryConfined(join(root, 'link.png'), [root]).ok).toBe(true)
  })
})
