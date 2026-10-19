import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { BROWSE_LIMITS } from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import { lzma2 } from '@napi-rs/lzma'
import { describe, expect, it } from 'vitest'
import { listAll, memoryFile, readEntry } from './memoryFile'
import { sevenZip, sevenZipProvider } from './sevenZip'

const MIB = 1024 * 1024
const DIR = join(__dirname, '../../../test/fixtures/archives/7z')
const A = 'hello 7z\n'.repeat(40)
const B = 'second file in a folder\n'.repeat(10)

function fixture(name: string): Buffer {
  return readFileSync(join(DIR, name))
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value >>> 0)
  return out
}

function rewrite(archive: Buffer, edit: (header: Buffer) => Buffer): Buffer {
  const offset = Number(archive.readBigUInt64LE(12))
  const size = Number(archive.readBigUInt64LE(20))
  const header = edit(Buffer.from(archive.subarray(32 + offset, 32 + offset + size)))
  const start = Buffer.alloc(20)
  start.writeBigUInt64LE(BigInt(offset), 0)
  start.writeBigUInt64LE(BigInt(header.length), 8)
  start.writeUInt32LE(crc32(header) >>> 0, 16)
  return Buffer.concat([
    archive.subarray(0, 8),
    u32(crc32(start)),
    start,
    archive.subarray(32, 32 + offset),
    header,
  ])
}

function at(buffer: Buffer, pattern: number[]): number {
  const found = buffer.indexOf(Buffer.from(pattern))
  expect(found, `pattern ${pattern}`).toBeGreaterThanOrEqual(0)
  return found
}

function emptyFiles(count: number, declared = count): Buffer {
  const bits = Buffer.alloc(Math.ceil(count / 8), 0xff)
  const names = Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: count }, (_unused, i) => Buffer.from(`f${i}\0`, 'utf16le')),
  ])
  const block = (type: number, body: Buffer): Buffer =>
    Buffer.concat([Buffer.from([type, ...numberBytes(body.length)]), body])
  const header = Buffer.concat([
    Buffer.from([0x01, 0x05, ...numberBytes(declared)]),
    block(0x0e, bits),
    block(0x0f, bits),
    block(0x11, names),
    Buffer.from([0x00, 0x00]),
  ])
  const start = Buffer.alloc(20)
  start.writeBigUInt64LE(0n, 0)
  start.writeBigUInt64LE(BigInt(header.length), 8)
  start.writeUInt32LE(crc32(header) >>> 0, 16)
  return Buffer.concat([
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]),
    u32(crc32(start)),
    start,
    header,
  ])
}

function seven(header: Buffer, packed: Buffer = Buffer.alloc(0)): Buffer {
  const start = Buffer.alloc(20)
  start.writeBigUInt64LE(BigInt(packed.length), 0)
  start.writeBigUInt64LE(BigInt(header.length), 8)
  start.writeUInt32LE(crc32(header) >>> 0, 16)
  return Buffer.concat([
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]),
    u32(crc32(start)),
    start,
    packed,
    header,
  ])
}

function numberBytes(value: number): number[] {
  const out = [0xff]
  for (let i = 0; i < 8; i++) out.push(Math.floor(value / 2 ** (8 * i)) % 256)
  return out
}

function shown(entries: Awaited<ReturnType<typeof listAll>>['entries']): unknown[] {
  return entries.map((e) => [e.name, e.dir ? 'dir' : e.link !== null ? `-> ${e.link}` : e.size])
}

const TREE = [
  ['src/emptydir', 'dir'],
  ['src/sub', 'dir'],
  ['src/empty.txt', 0],
  ['src/a.txt', 360],
  ['src/link', '-> a.txt'],
  ['src/prog.exe', 521],
  ['src/sub/b.txt', 240],
]

describe('7z provider on archives 7-Zip wrote', () => {
  it.each(['lzma2.7z', 'lzma1.7z', 'nonsolid.7z', 'plainheader.7z', 'copy.7z'])(
    'lists %s and opens its files, solid or not, with an encoded header or a plain one',
    async (name) => {
      const { entries, result } = await listAll(sevenZip, memoryFile(fixture(name)))
      expect(result).toEqual({ ok: true, complete: true })
      expect(shown(entries)).toEqual(TREE)
      const bytes = async (index: number) => {
        const read = await readEntry(sevenZip, memoryFile(fixture(name)), index)
        expect(read.result).toEqual({ ok: true })
        return read.data
      }
      expect((await bytes(3)).toString()).toBe(A)
      expect((await bytes(6)).toString()).toBe(B)
      expect((await bytes(2)).length).toBe(0)
      expect((await bytes(5)).length).toBe(521)
    },
  )

  it('reads a BCJ x86 + LZMA2 folder back through the filter, checking the entry CRC', async () => {
    const { entries } = await listAll(sevenZip, memoryFile(fixture('bcj.7z')))
    expect(shown(entries)).toEqual([['src/prog.exe', 521]])
    expect((await readEntry(sevenZip, memoryFile(fixture('bcj.7z')), 0)).result).toEqual({
      ok: true,
    })
  })

  it('refuses a link, a directory and a missing entry without decoding', async () => {
    const file = memoryFile(fixture('lzma2.7z'))
    expect((await readEntry(sevenZip, file, 4)).result).toEqual({ ok: false, error: 'link' })
    expect((await readEntry(sevenZip, file, 0)).result).toEqual({ ok: false, error: 'gone' })
    expect((await readEntry(sevenZip, file, 99)).result).toEqual({ ok: false, error: 'gone' })
  })

  it('names the coders it does not read and an encrypted header, and marks encrypted content', async () => {
    for (const name of ['bcj2.7z', 'deflate.7z', 'ppmd.7z']) {
      const { result } = await listAll(sevenZip, memoryFile(fixture(name)))
      expect(result, name).toEqual({ ok: false, error: 'unsupported' })
    }
    expect((await listAll(sevenZip, memoryFile(fixture('headerenc.7z')))).result).toEqual({
      ok: false,
      error: 'encrypted',
    })
    const { entries } = await listAll(sevenZip, memoryFile(fixture('contentenc.7z')))
    expect(entries.map((e) => [e.name, e.encrypted])).toEqual([
      ['src/sub', false],
      ['src/a.txt', true],
      ['src/sub/b.txt', true],
    ])
    expect((await readEntry(sevenZip, memoryFile(fixture('contentenc.7z')), 1)).result).toEqual({
      ok: false,
      error: 'encrypted',
    })
  })
})

describe('7z limits and damage', () => {
  it('refuses a dictionary over 64 MiB before decoding', async () => {
    const archive = rewrite(fixture('plainheader.7z'), (header) => {
      header[at(header, [0x21, 0x21, 0x01]) + 3] = 0x28
      return header
    })
    expect((await listAll(sevenZip, memoryFile(archive))).result).toEqual({
      ok: false,
      error: 'unsupported',
    })
  })

  it('answers corrupt for a data CRC mismatch, a cut file, a damaged CRC and lying sizes', async () => {
    const copy = fixture('copy.7z')
    copy[copy.indexOf('hello 7z')] ^= 0x01
    expect((await readEntry(sevenZip, memoryFile(copy), 3)).result).toEqual({
      ok: false,
      error: 'corrupt',
    })
    const whole = fixture('lzma2.7z')
    for (const cut of [whole.subarray(0, whole.length - 10), whole.subarray(0, 40)]) {
      expect((await listAll(sevenZip, memoryFile(cut))).result).toEqual({
        ok: false,
        error: 'corrupt',
      })
    }
    const flipped = Buffer.from(whole)
    flipped[whole.length - 5] ^= 0xff
    expect((await listAll(sevenZip, memoryFile(flipped))).result).toEqual({
      ok: false,
      error: 'corrupt',
    })
    const longer = rewrite(fixture('copyplain.7z'), (header) => {
      header.set([0x93, 0x88], at(header, [0x06, 0x00, 0x02, 0x09]) + 4)
      return header
    })
    expect((await listAll(sevenZip, memoryFile(longer))).result).toEqual({
      ok: false,
      error: 'corrupt',
    })
    const bigger = rewrite(fixture('plainheader.7z'), (header) => {
      header.set([0x8f, 0xff], at(header, [0x08, 0x0d, 0x04, 0x09]) + 4)
      return header
    })
    expect((await listAll(sevenZip, memoryFile(bigger))).result).toEqual({
      ok: false,
      error: 'corrupt',
    })
    const shorter = rewrite(fixture('copyplain.7z'), (header) => {
      header.set([0x80, 0x10], at(header, [0x0c, 0x81, 0x68]) + 1)
      return header
    })
    expect((await readEntry(sevenZip, memoryFile(shorter), 0)).result).toEqual({
      ok: false,
      error: 'corrupt',
    })
  })

  it('is not fooled by a file that is not a 7z, or one that is too short to be one', async () => {
    for (const bytes of [Buffer.from('plain text, nothing packed'), Buffer.alloc(64, 7)]) {
      expect((await listAll(sevenZip, memoryFile(bytes))).result).toEqual({
        ok: false,
        error: 'unsupported',
      })
    }
  })

  it('lists an empty archive, cuts 20,001 files and refuses a count the header cannot hold', async () => {
    const empty = Buffer.concat([
      Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]),
      u32(crc32(Buffer.alloc(20))),
      Buffer.alloc(20),
    ])
    expect(await listAll(sevenZip, memoryFile(empty))).toMatchObject({
      result: { ok: true, complete: true },
      entries: [],
    })
    const many = await listAll(sevenZip, memoryFile(emptyFiles(20_001)))
    expect(many.result).toEqual({ ok: true, complete: false })
    expect(many.entries).toHaveLength(BROWSE_LIMITS.entries + 1)
    expect(many.entries[0]).toMatchObject({ name: 'f0', dir: false, size: 0 })
    const huge = await listAll(sevenZip, memoryFile(emptyFiles(3, 4_000_000_000)))
    expect(huge.result).toEqual({ ok: false, error: 'corrupt' })
  })

  it('stops a solid block read at the decoded budget, and blanks a link past it', async () => {
    const budget = { ...BROWSE_LIMITS, scanBytes: 500 }
    const deep = await readEntry(sevenZip, memoryFile(fixture('lzma2.7z')), 6, MIB, budget)
    expect(deep.result).toEqual({ ok: false, error: 'limit' })
    const roomy = { ...BROWSE_LIMITS, scanBytes: 2_000 }
    const whole = await readEntry(sevenZip, memoryFile(fixture('lzma2.7z')), 6, MIB, roomy)
    expect(whole.result).toEqual({ ok: true })
    const { entries, result } = await listAll(sevenZip, memoryFile(fixture('lzma2.7z')), {
      ...BROWSE_LIMITS,
      scanBytes: 100,
    })
    expect(result).toEqual({ ok: true, complete: true })
    expect(entries.find((e) => e.name === 'src/link')).toMatchObject({ link: '' })
  })

  it('stops a 64 MiB bomb at the decoded budget', async () => {
    const file = memoryFile(fixture('bomb.7z'))
    const { entries } = await listAll(sevenZip, file)
    expect(entries).toEqual([
      { name: 'zeros', dir: false, size: 64 * MIB, encrypted: false, link: null },
    ])
    const read = await readEntry(sevenZip, memoryFile(fixture('bomb.7z')), 0, 128 * MIB, {
      ...BROWSE_LIMITS,
      scanBytes: 4 * MIB,
    })
    expect(read.result).toEqual({ ok: false, error: 'limit' })
    expect(read.data.length).toBeLessThanOrEqual(4 * MIB)
  })

  it('stops when the request is cancelled', async () => {
    const abort = new AbortController()
    abort.abort()
    const { result } = await listAll(
      sevenZip,
      memoryFile(fixture('lzma2.7z')),
      undefined,
      abort.signal,
    )
    expect(result).toEqual({ ok: false, error: 'cancelled' })
  })

  it('survives headers that declare millions of files or substreams, plain or packed small', async () => {
    const started = Date.now()
    const bits = (count: number): Buffer => Buffer.alloc(Math.ceil(count / 8), 0xff)
    const block = (type: number, body: Buffer): Buffer =>
      Buffer.concat([Buffer.from([type, ...numberBytes(body.length)]), body])

    const files = 60_000_000
    const inner = Buffer.concat([
      Buffer.from([0x01, 0x05, ...numberBytes(files)]),
      block(0x0e, bits(files)),
      block(0x19, Buffer.alloc(files - Math.ceil(files / 8) + 64)),
      Buffer.from([0x00, 0x00]),
    ])
    expect(inner.length).toBeLessThan(64 * 1024 * 1024)
    const packedInner = Buffer.from(lzma2.compressSync(inner))
    expect(packedInner.length).toBeLessThan(inner.length / 100)
    const encoded = Buffer.from([
      0x17,
      0x06,
      0x00,
      0x01,
      0x09,
      ...numberBytes(packedInner.length),
      0x00,
      0x07,
      0x0b,
      0x01,
      0x00,
      0x01,
      0x21,
      0x21,
      0x01,
      0x16,
      0x0c,
      ...numberBytes(inner.length),
      0x00,
      0x00,
    ])
    const small = seven(encoded, packedInner)
    expect(small.length).toBeLessThan(100_000)
    const packedList = await listAll(sevenZip, memoryFile(small))
    expect(packedList.result).toEqual({ ok: true, complete: false })
    expect(packedList.entries).toHaveLength(BROWSE_LIMITS.entries + 1)
    expect(packedList.entries[0]).toMatchObject({ name: '', dir: true })

    const streams = 10_000_000
    const sizes = Buffer.alloc(streams - 1)
    const names = Buffer.concat([
      Buffer.from([0]),
      ...['a', 'b', 'c'].map((name) => Buffer.from(`${name}\0`, 'utf16le')),
    ])
    const manySubstreams = Buffer.concat([
      Buffer.from([0x01, 0x04, 0x06, 0x00, 0x01, 0x09, 0x0a, 0x00]),
      Buffer.from([0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, 0x0c, 0x0a, 0x00]),
      Buffer.from([0x08, 0x0d, ...numberBytes(streams), 0x09]),
      sizes,
      Buffer.from([0x00, 0x00, 0x05, 0x03]),
      block(0x11, names),
      Buffer.from([0x00, 0x00]),
    ])
    const many = await listAll(sevenZip, memoryFile(seven(manySubstreams, Buffer.alloc(10))))
    expect(many.result).toEqual({ ok: true, complete: true })
    expect(many.entries.map((entry) => [entry.name, entry.size])).toEqual([
      ['a', 0],
      ['b', 0],
      ['c', 0],
    ])

    const crcs = Buffer.concat([
      Buffer.from([0x01, 0x04, 0x06, 0x00, 0x01, 0x09, 0x0a, 0x00]),
      Buffer.from([0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, 0x0c, 0x0a, 0x00]),
      Buffer.from([0x08, 0x0d, ...numberBytes(streams), 0x0a, 0x01, 1, 2, 3, 4]),
    ])
    expect((await listAll(sevenZip, memoryFile(seven(crcs, Buffer.alloc(10))))).result).toEqual({
      ok: false,
      error: 'corrupt',
    })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('reads Copy folders without the native module and fails an LZMA folder as failed when it is missing', async () => {
    const calls = { n: 0 }
    const missing = () => {
      calls.n += 1
      throw new Error('Cannot find module @napi-rs/lzma-linux-x64-gnu')
    }
    const provider = sevenZipProvider({ lzma: missing, lzma2: missing })
    const plain = fixture('copyplain.7z')
    const listed = await listAll(provider, memoryFile(plain))
    expect(listed.result).toEqual({ ok: true, complete: true })
    const read = await readEntry(provider, memoryFile(plain), 0)
    expect(read.result).toEqual({ ok: true })
    expect(read.data.toString()).toBe(A)
    expect(calls.n).toBe(0)
    const packed = await listAll(provider, memoryFile(fixture('lzma2.7z')))
    expect(packed.result).toEqual({ ok: false, error: 'failed' })
    expect(calls.n).toBe(1)
  })
})
