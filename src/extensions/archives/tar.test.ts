import { randomBytes } from 'node:crypto'
import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { tarOf } from '../../../test/fixtures/archives/archives'
import { listAll, memoryFile, readEntry } from './memoryFile'
import { tar } from './tar'

const MIB = 1024 * 1024
const LIMITS = {
  entries: 20_000,
  depth: 32,
  nameLength: 1024,
  scanBytes: 1024 * MIB,
  scanMs: 20_000,
  linkTargetBytes: 1024,
}

const items = [
  { name: 'a.txt', data: 'first' },
  { name: 'b.txt', data: 'last' },
]

function names(entries: { name: string }[]): string[] {
  return entries.map((entry) => entry.name)
}

describe('tar provider', () => {
  it('lists and reads a plain tar, a tar.gz and a tar.zst alike', async () => {
    const plain = tarOf(items, false)
    for (const bytes of [plain, gzipSync(plain), zstdCompressSync(plain)]) {
      const file = memoryFile(bytes)
      const { entries, result } = await listAll(tar, file)
      expect(result).toEqual({ ok: true, complete: true })
      expect(names(entries)).toEqual(['a.txt', 'b.txt'])
      const read = await readEntry(tar, memoryFile(bytes), 1)
      expect(read.result).toEqual({ ok: true })
      expect(read.data.toString()).toBe('last')
    }
  })

  it('shows links with their target and never reads them', async () => {
    const file = memoryFile(tarOf([{ name: 'passwd', type: '2', link: '../../etc/passwd' }]))
    const { entries } = await listAll(tar, file)
    expect(entries).toEqual([
      { name: 'passwd', dir: false, size: 0, encrypted: false, link: '../../etc/passwd' },
    ])
    expect((await readEntry(tar, file, 0)).result).toEqual({ ok: false, error: 'link' })
  })

  it('shortens a name over the cap and blanks a link over the cap instead of failing the listing', async () => {
    const name = `${'d'.repeat(5000)}.txt`
    const file = memoryFile(
      tarOf([
        { name: 'cut', longName: name, data: 'x' },
        { name: 'far', type: '2', link: 'x', longLink: 'l'.repeat(2000) },
        { name: 'ok.txt', data: 'y' },
      ]),
    )
    const { entries, result } = await listAll(tar, file)
    expect(result).toEqual({ ok: true, complete: true })
    expect(entries.map((entry) => Buffer.byteLength(entry.name))).toEqual([4096, 3, 6])
    expect(entries[0].name.endsWith('…')).toBe(true)
    expect(entries[1]).toMatchObject({ name: 'far', link: '' })
    expect((await readEntry(tar, file, 0)).data.toString()).toBe('x')
  })

  it('reports a missing entry as gone and an entry over the cap as too large', async () => {
    const file = memoryFile(tarOf([{ name: 'big.txt', data: 'x'.repeat(5000) }], false))
    expect((await readEntry(tar, file, 3)).result).toEqual({ ok: false, error: 'gone' })
    expect(
      (
        await readEntry(
          tar,
          memoryFile(tarOf([{ name: 'big.txt', data: 'x'.repeat(5000) }], false)),
          0,
          1000,
        )
      ).result,
    ).toMatchObject({
      ok: false,
      error: 'too-large',
    })
  })

  describe.each([
    ['tar', false],
    ['tar.gz', true],
  ])('%s with data after the end marker', (_name, compress) => {
    function trailing() {
      const bytes = Buffer.concat([tarOf(items, false), randomBytes(2 * MIB)])
      return memoryFile(compress ? gzipSync(bytes) : bytes)
    }

    it('lists every entry and stops reading the file at the marker', async () => {
      const file = trailing()
      const { entries } = await listAll(tar, file)
      expect(names(entries)).toEqual(['a.txt', 'b.txt'])
      expect(file.served).toBeLessThan(MIB)
      expect(file.streams.every((stream) => stream.destroyed)).toBe(true)
    })

    it('reads the last entry and stops reading the file at the marker', async () => {
      const file = trailing()
      const read = await readEntry(tar, file, 1)
      expect(read.data.toString()).toBe('last')
      expect(file.served).toBeLessThan(MIB)
    })
  })

  describe.each([
    ['zstd', (bytes: Buffer) => zstdCompressSync(bytes)],
    ['gzip', (bytes: Buffer) => gzipSync(bytes)],
  ])('%s with a very high ratio', (_name, compress) => {
    const limits = { ...LIMITS, scanBytes: 4 * MIB }

    it('stops listing after a bounded output and reports the limit', async () => {
      const file = memoryFile(compress(Buffer.alloc(64 * MIB, 0x41)))
      const { result } = await listAll(tar, file, limits)
      expect(result).toEqual({ ok: false, error: 'limit' })
    })

    it('stops reading an entry after a bounded output and says why', async () => {
      const file = memoryFile(compress(Buffer.alloc(64 * MIB, 0x41)))
      expect((await readEntry(tar, file, 0, MIB, limits)).result).toEqual({
        ok: false,
        error: 'limit',
      })
    })
  })

  it('stops a listing at the scan limit and keeps what it has', async () => {
    const many = Array.from({ length: 20 }, (_unused, i) => ({
      name: `f${i}.txt`,
      data: 'x'.repeat(4096),
    }))
    const { entries, result } = await listAll(tar, memoryFile(tarOf(many)), {
      ...LIMITS,
      scanBytes: 8 * 4608,
    })
    expect(result.ok).toBe(true)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.length).toBeLessThan(20)
  })

  it.each([
    ['gzip in gzip', (bytes: Buffer) => gzipSync(gzipSync(bytes))],
    ['zstd in gzip', (bytes: Buffer) => gzipSync(zstdCompressSync(bytes))],
  ])('does not open %s', async (_name, nest) => {
    const bytes = nest(Buffer.from(tarOf([{ name: 'a.txt', data: 'x' }], false)))
    const { result } = await listAll(tar, memoryFile(bytes))
    expect(result.ok).toBe(false)
    expect((await readEntry(tar, memoryFile(bytes), 0)).result).toEqual({
      ok: false,
      error: 'gone',
    })
  })

  it.each([
    ['alone', (bytes: Buffer) => bytes],
    ['inside gzip', (bytes: Buffer) => gzipSync(bytes)],
  ])('never decompresses brotli, %s', async (_name, wrap) => {
    const file = memoryFile(wrap(brotliCompressSync(Buffer.alloc(64 * MIB, 0x41))))
    const { entries } = await listAll(tar, file)
    expect(entries).toEqual([])
    expect(file.served).toBeLessThan(MIB)
  })
})
