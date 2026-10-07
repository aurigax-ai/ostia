import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { FS_TEXT_SNIFF_BYTES, readTextConfined, versionConfined, writeText } from './fsText'
import { resolveSafe } from './pathGuard'

let root: string
let outside: string
const confine = (path: string): string | null => resolveSafe(path, [root])
const runsAsRoot = process.getuid?.() === 0

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-fstext-root-'))
  outside = mkdtempSync(join(tmpdir(), 'ostia-fstext-out-'))
  writeFileSync(join(root, 'a.txt'), 'héllo\n')
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(64))
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0, 1]))
  writeFileSync(join(root, 'late-nul.txt'), `${'x'.repeat(FS_TEXT_SNIFF_BYTES)}\0`)
  writeFileSync(join(root, 'locked.txt'), 'secret')
  chmodSync(join(root, 'locked.txt'), 0o000)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  mkdirSync(join(root, 'dir'))
})

describe('readTextConfined', () => {
  it('returns the UTF-8 text of a file inside an allowed root', async () => {
    expect(await readTextConfined(join(root, 'a.txt'), confine)).toMatchObject({
      ok: true,
      text: 'héllo\n',
    })
  })

  it('refuses a path outside every allowed root and a non-string path', async () => {
    expect(await readTextConfined(join(outside, 'secret.txt'), confine)).toEqual({
      ok: false,
      error: 'denied',
    })
    expect(await readTextConfined(42, confine)).toEqual({ ok: false, error: 'denied' })
  })

  it('reports a file over the cap without reading it', async () => {
    expect(await readTextConfined(join(root, 'big.txt'), confine, 32)).toEqual({
      ok: false,
      error: 'too-large',
      size: 64,
    })
  })

  it('reports a NUL in the first 8 KiB as binary and one after it as text', async () => {
    expect(await readTextConfined(join(root, 'blob.bin'), confine)).toEqual({
      ok: false,
      error: 'binary',
    })
    expect((await readTextConfined(join(root, 'late-nul.txt'), confine)).ok).toBe(true)
  })

  it('tells a missing file apart from one that cannot be read', async () => {
    expect(await readTextConfined(join(root, 'nope.txt'), confine)).toEqual({
      ok: false,
      error: 'missing',
    })
    expect(await readTextConfined(join(root, 'dir'), confine)).toEqual({
      ok: false,
      error: 'unreadable',
    })
  })

  it.skipIf(runsAsRoot)('reports a file without read permission as unreadable', async () => {
    expect(await readTextConfined(join(root, 'locked.txt'), confine)).toEqual({
      ok: false,
      error: 'unreadable',
    })
  })

  it('returns the same version as fs:version until the file is written again', async () => {
    const file = join(root, 'versioned.txt')
    writeFileSync(file, 'one')
    const read = await readTextConfined(file, confine)
    const before = await versionConfined(file, confine)
    expect(read.ok && read.version).toBe(before)
    await new Promise((r) => setTimeout(r, 20))
    await writeText(file, 'three')
    const after = await versionConfined(file, confine)
    expect(after).not.toBeNull()
    expect(after).not.toBe(before)
  })

  it('has no version for a missing file, a folder or a path outside the roots', async () => {
    expect(await versionConfined(join(root, 'nope.txt'), confine)).toBeNull()
    expect(await versionConfined(join(root, 'dir'), confine)).toBeNull()
    expect(await versionConfined(join(outside, 'secret.txt'), confine)).toBeNull()
  })
})
