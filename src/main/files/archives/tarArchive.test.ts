import { randomBytes } from 'node:crypto'
import type { ReadStream } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGunzip, gzipSync, zstdCompressSync } from 'node:zlib'
import type { Parser } from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const opened: ReadStream[] = vi.hoisted(() => [])
const parsers: object[] = vi.hoisted(() => [])

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    createReadStream: ((...args: Parameters<typeof fs.createReadStream>) => {
      const stream = fs.createReadStream(...args)
      opened.push(stream)
      return stream
    }) as typeof fs.createReadStream,
  }
})

vi.mock('tar', async (importOriginal) => {
  const tar = await importOriginal<typeof import('tar')>()
  class RecordingParser extends tar.Parser {
    constructor(...args: ConstructorParameters<typeof tar.Parser>) {
      super(...args)
      parsers.push(this)
      vi.spyOn(this as Parser, 'write')
    }
  }
  return { ...tar, Parser: RecordingParser }
})

import { tarOf } from '../../../../test/fixtures/archives/archives'
import { ARCHIVE_LIMITS, type ArchiveLimits } from './archiveTree'
import { listTar, readTarEntry } from './tarArchive'

const MIB = 1024 * 1024
const TRAILING = 2 * MIB
const FILE_CHUNK = 64 * 1024
let dir: string

type Compress = (bytes: Buffer) => Buffer

interface SyncZlib {
  _processChunk(chunk: Buffer, flushFlag: number, cb?: () => void): Buffer | Buffer[] | undefined
}

const inflatedSync: number[] = []

function zlibBase(): SyncZlib {
  const probe = createGunzip()
  let proto: object | null = Object.getPrototypeOf(probe)
  probe.close()
  while (proto && !Object.hasOwn(proto, '_processChunk')) proto = Object.getPrototypeOf(proto)
  if (!proto) throw new Error('_processChunk not found')
  return proto as SyncZlib
}

function sizeOf(out: Buffer | Buffer[] | undefined): number {
  if (!out) return 0
  return Array.isArray(out) ? out.reduce((sum, part) => sum + part.length, 0) : out.length
}

function written(): number[] {
  return parsers.flatMap((parser) =>
    vi.mocked((parser as Parser).write).mock.calls.map(([chunk]) => chunk.length),
  )
}

function largestStep(): number {
  return Math.max(0, ...inflatedSync, ...written())
}

function decompressedBytes(): number {
  return [...inflatedSync, ...written()].reduce((sum, size) => sum + size, 0)
}

function put(name: string, bytes: Buffer): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  inflatedSync.length = 0
  return path
}

function withTrailing(compress: Compress | null): string {
  const tar = tarOf(
    [
      { name: 'a.txt', data: 'first' },
      { name: 'b.txt', data: 'last' },
    ],
    false,
  )
  const bytes = Buffer.concat([tar, randomBytes(TRAILING)])
  return put('trailing', compress ? compress(bytes) : bytes)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tar-eof-'))
  opened.length = 0
  parsers.length = 0
  inflatedSync.length = 0
  const base = zlibBase()
  const original = base._processChunk
  vi.spyOn(base, '_processChunk').mockImplementation(function (this: SyncZlib, chunk, flush, cb) {
    const out = original.call(this, chunk, flush, cb)
    if (!cb) inflatedSync.push(sizeOf(out))
    return out
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe.each([
  ['tar', null],
  ['tar.gz', gzipSync],
  ['tar.zst', zstdCompressSync],
])('%s with data after the end marker', (_name, compress) => {
  it('lists every entry and stops reading the file at the marker', async () => {
    const listed = await listTar(withTrailing(compress), ARCHIVE_LIMITS)
    expect(listed?.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(opened).toHaveLength(1)
    expect(opened[0].destroyed).toBe(true)
    expect(opened[0].bytesRead).toBeLessThan(MIB)
  })

  it('reads the last entry and stops reading the file at the marker', async () => {
    const read = await readTarEntry(withTrailing(compress), 1, MIB, ARCHIVE_LIMITS)
    expect(read.ok && read.data.toString()).toBe('last')
    expect(opened).toHaveLength(1)
    expect(opened[0].destroyed).toBe(true)
    expect(opened[0].bytesRead).toBeLessThan(MIB)
  })

  it('reports a missing entry and stops reading the file at the marker', async () => {
    const read = await readTarEntry(withTrailing(compress), 2, MIB, ARCHIVE_LIMITS)
    expect(read).toEqual({ ok: false, problem: 'gone' })
    expect(opened).toHaveLength(1)
    expect(opened[0].destroyed).toBe(true)
    expect(opened[0].bytesRead).toBeLessThan(MIB)
  })
})

describe.each([
  ['tar.gz', gzipSync],
  ['tar.zst', zstdCompressSync],
])('%s with zeros after the end marker inside the compressed stream', (_name, compress) => {
  const ZEROS = 16 * MIB

  function zerosInside(): string {
    const tar = tarOf(
      [
        { name: 'a.txt', data: 'first' },
        { name: 'b.txt', data: 'last' },
      ],
      false,
    )
    return put('zeros', compress(Buffer.concat([tar, Buffer.alloc(ZEROS)])))
  }

  it('lists every entry and stops decompressing at the marker', async () => {
    const path = zerosInside()
    const listed = await listTar(path, ARCHIVE_LIMITS)
    expect(listed?.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(opened[0].destroyed).toBe(true)
    expect(decompressedBytes()).toBeLessThan(MIB)
  })

  it('reads the last entry and stops decompressing at the marker', async () => {
    const path = zerosInside()
    const read = await readTarEntry(path, 1, MIB, ARCHIVE_LIMITS)
    expect(read.ok && read.data.toString()).toBe('last')
    expect(opened[0].destroyed).toBe(true)
    expect(decompressedBytes()).toBeLessThan(MIB)
  })
})

describe.each([
  ['gzip', gzipSync],
  ['zstd', zstdCompressSync],
])('%s data with a very high ratio', (_name, compress) => {
  const PLAIN = 8 * MIB
  const limits: ArchiveLimits = { ...ARCHIVE_LIMITS, scanBytes: MIB }

  function bomb(): string {
    const packed = compress(Buffer.alloc(PLAIN, 0xff))
    expect(packed.length).toBeLessThan(PLAIN / 256)
    return put('bomb.tar', packed)
  }

  it('stops a listing with an error after a bounded output, one small step at a time', async () => {
    expect(await listTar(bomb(), limits)).toBeNull()
    expect(largestStep()).toBeLessThanOrEqual(FILE_CHUNK)
    expect(decompressedBytes()).toBeLessThanOrEqual(limits.scanBytes + FILE_CHUNK)
    expect(opened[0].destroyed).toBe(true)
  })

  it('stops reading an entry with an error after a bounded output, one small step at a time', async () => {
    expect(await readTarEntry(bomb(), 0, MIB, limits)).toEqual({ ok: false, problem: 'gone' })
    expect(largestStep()).toBeLessThanOrEqual(FILE_CHUNK)
    expect(decompressedBytes()).toBeLessThanOrEqual(limits.scanBytes + FILE_CHUNK)
    expect(opened[0].destroyed).toBe(true)
  })

  it('refuses an archive compressed twice', async () => {
    const tar = tarOf([{ name: 'a.txt', data: 'first' }], false)
    const path = put('twice.tar', compress(compress(Buffer.from(tar))))
    expect(await listTar(path, limits)).toBeNull()
    expect(inflatedSync).toEqual([])
  })
})
