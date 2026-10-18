import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { crc32 } from 'node:zlib'
import type { ArchiveReaderLimits } from '@aurigax-ai/ostia-extension-sdk/contract/archiveReaders'
import { XzCompressor } from '@napi-rs/lzma'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tarOf } from '../../../test/fixtures/archives/archives'
import { listArchive, readArchive } from './archiveAnswers'
import { XZ_DICT_MAX, XzGuard, lzma2DictSize } from './xzGuard'
import { xzOpener } from './xzSource'

const BLOCK = 12
const LIMITS: ArchiveReaderLimits = {
  entries: 20_000,
  depth: 32,
  nameLength: 1_024,
  scanBytes: 1024 * 1024 * 1024,
  scanMs: 20_000,
  linkTargetBytes: 1_024,
}

async function xz(bytes: Uint8Array): Promise<Buffer> {
  const compressor = new XzCompressor({ preset: 0 })
  return Buffer.concat([compressor.update(bytes), await compressor.finish()])
}

function editBlockHeader(packed: Buffer, edit: (header: Buffer) => void): Buffer {
  const out = Buffer.from(packed)
  const size = (out[BLOCK] + 1) * 4
  const header = out.subarray(BLOCK, BLOCK + size)
  edit(header)
  header.writeUInt32LE(crc32(header.subarray(0, size - 4)), size - 4)
  return out
}

function filterAt(header: Buffer): number {
  expect(header[1] & 0xc0).toBe(0)
  return 2
}

function withDict(packed: Buffer, prop: number): Buffer {
  return editBlockHeader(packed, (header) => {
    const at = filterAt(header)
    expect([header[at], header[at + 1]]).toEqual([0x21, 0x01])
    header[at + 2] = prop
  })
}

function guarded(bytes: Uint8Array, chunk = bytes.length): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const guard = new XzGuard()
    const out: Buffer[] = []
    guard.on('data', (data: Buffer) => out.push(data))
    guard.on('error', reject)
    guard.on('end', () => resolve(Buffer.concat(out)))
    for (let at = 0; at < bytes.length; at += chunk) guard.write(bytes.subarray(at, at + chunk))
    guard.end()
  })
}

const TAR = tarOf([{ name: 'a.txt', data: 'hello '.repeat(500) }], false)

describe('XzGuard', () => {
  it('passes a well-formed xz through unchanged, whatever the chunk size', async () => {
    const packed = await xz(TAR)
    expect((await guarded(packed)).equals(packed)).toBe(true)
    expect((await guarded(packed, 1)).equals(packed)).toBe(true)
    expect((await guarded(packed, 7)).equals(packed)).toBe(true)
  })

  it('passes streams one after another with stream padding between them', async () => {
    const both = Buffer.concat([await xz(TAR), Buffer.alloc(8), await xz(TAR)])
    expect((await guarded(both, 5)).equals(both)).toBe(true)
    const odd = Buffer.concat([await xz(TAR), Buffer.alloc(3), await xz(TAR)])
    await expect(guarded(odd)).rejects.toThrow(/stream padding/)
  })

  it('knows the LZMA2 dictionary sizes and allows up to 64 MiB', async () => {
    expect(lzma2DictSize(0)).toBe(4096)
    expect(lzma2DictSize(28)).toBe(XZ_DICT_MAX)
    expect(lzma2DictSize(29)).toBe(96 * 1024 * 1024)
    expect(lzma2DictSize(40)).toBe(0xffffffff)
    const packed = withDict(await xz(TAR), 28)
    expect((await guarded(packed)).equals(packed)).toBe(true)
  })

  it('refuses a dictionary over 64 MiB, another filter, two filters and a cut stream', async () => {
    const packed = await xz(TAR)
    for (const prop of [29, 39, 40]) {
      await expect(guarded(withDict(packed, prop))).rejects.toThrow(/dictionary/)
    }
    const delta = editBlockHeader(packed, (header) => {
      header[filterAt(header)] = 0x03
    })
    await expect(guarded(delta)).rejects.toThrow(/LZMA2 filter/)
    const two = editBlockHeader(packed, (header) => {
      header[1] = 0x01
    })
    await expect(guarded(two)).rejects.toThrow(/LZMA2 filter/)
    const crc = Buffer.from(packed)
    crc[BLOCK + 2] ^= 0x01
    await expect(guarded(crc)).rejects.toThrow(/block header CRC/)
    await expect(guarded(packed.subarray(0, packed.length - 1))).rejects.toThrow(/cut/)
    await expect(guarded(Buffer.from('not xz'))).rejects.toThrow()
  })
})

describe('an xz with a huge dictionary', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xz-guard-'))
    mkdirSync(join(dir, 'archive-reads'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is refused for list and read before the decoder sees one byte', async () => {
    const path = join(dir, 'huge.tar.xz')
    writeFileSync(path, withDict(await xz(TAR), 40))
    let received = 0
    const opener = xzOpener(() => {
      const decoder = new PassThrough()
      decoder.on('data', (chunk: Buffer) => {
        received += chunk.length
      })
      return decoder
    })
    const live = new AbortController().signal
    const list = { op: 'list', reader: 'xz', archive: path, limits: LIMITS } as const
    expect(await listArchive(list, opener, live)).toEqual({ ok: false, error: 'failed' })
    const out = join(dir, 'archive-reads', 'e1')
    const read = { ...list, op: 'read', index: 0, max: 1024, out } as const
    expect((await readArchive(read, opener, live, join(dir, 'archive-reads'))).ok).toBe(false)
    expect(received).toBe(0)
  })
})
