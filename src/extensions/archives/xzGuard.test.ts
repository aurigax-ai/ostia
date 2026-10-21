import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { crc32 } from 'node:zlib'
import { XzCompressor } from '@napi-rs/lzma'
import { createDecompressStream } from '@napi-rs/lzma/xz'
import { describe, expect, it } from 'vitest'
import { tarOf } from '../../../test/fixtures/archives/archives'
import { archiveDecoders } from '../../../test/fixtures/archives/decoders'
import { listAll, memoryFile, readEntry } from './memoryFile'
import { tarProvider } from './tar'
import { lzma2DictSize, XZ_DICT_MAX, XzGuard } from './xzGuard'

const BLOCK = 12
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
  it('is refused for list and read before the decoder sees one byte', async () => {
    let received = 0
    const tar = tarProvider({
      ...archiveDecoders,
      xz: () => {
        const decoder = new PassThrough()
        decoder.on('data', (chunk: Buffer) => {
          received += chunk.length
        })
        return decoder
      },
    })
    const file = memoryFile(withDict(await xz(TAR), 40))
    const listed = await listAll(tar, file)
    expect(listed.result.ok).toBe(false)
    expect(listed.entries).toEqual([])
    expect((await readEntry(tar, memoryFile(withDict(await xz(TAR), 40)), 0)).result.ok).toBe(false)
    expect(received).toBe(0)
  })
})

function varint(value: number): number[] {
  const out: number[] = []
  let left = value
  while (left >= 0x80) {
    out.push((left & 0x7f) | 0x80)
    left = Math.floor(left / 0x80)
  }
  return [...out, left]
}

function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24]
}

function padTo4(bytes: number[]): number[] {
  return [...bytes, ...new Array((4 - (bytes.length % 4)) % 4).fill(0)]
}

interface Built {
  bytes: number[]
  unpadded: number
  uncompressed: number
}

function stored(data: Uint8Array): number[] {
  const out: number[] = []
  for (let at = 0; at < data.length; at += 65_536) {
    const piece = data.subarray(at, at + 65_536)
    out.push(at === 0 ? 0x01 : 0x02, (piece.length - 1) >> 8, (piece.length - 1) & 0xff, ...piece)
  }
  return [...out, 0x00]
}

function packed(junk: number): number[] {
  const unpacked = 4096 - 1
  return [
    0xe0 | (unpacked >> 16),
    (unpacked >> 8) & 0xff,
    unpacked & 0xff,
    (junk - 1) >> 8,
    (junk - 1) & 0xff,
    0x5d,
    ...randomBytes(junk),
    0x00,
  ]
}

function block(prop: number, lzma2: number[], uncompressed: number): Built {
  const fields = padTo4([0, 0x00, 0x21, 0x01, prop, 0, 0, 0, 0].slice(0, 5))
  const header = [...fields, 0, 0, 0, 0]
  header[0] = header.length / 4 - 1
  const crc = crc32(Uint8Array.from(header.slice(0, -4)))
  header.splice(-4, 4, ...le32(crc))
  const body = [...header, ...lzma2]
  return { bytes: padTo4(body), unpadded: body.length, uncompressed }
}

function stream(blocks: Built[]): { bytes: number[]; headers: number[] } {
  const flags = [0x00, 0x00]
  const out = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, ...flags, ...le32(crc32(Uint8Array.from(flags)))]
  const headers: number[] = []
  for (const built of blocks) {
    headers.push(out.length)
    out.push(...built.bytes)
  }
  const records = blocks.flatMap((built) => [
    ...varint(built.unpadded),
    ...varint(built.uncompressed),
  ])
  const index = padTo4([0x00, ...varint(blocks.length), ...records])
  index.push(...le32(crc32(Uint8Array.from(index))))
  const backward = le32(index.length / 4 - 1)
  const tail = [...backward, ...flags]
  out.push(...index, ...le32(crc32(Uint8Array.from(tail))), ...tail, 0x59, 0x5a)
  return { bytes: out, headers }
}

function counted(bytes: Uint8Array): Promise<{ refused: boolean; received: number }> {
  return new Promise((resolve) => {
    const guard = new XzGuard()
    let received = 0
    guard.on('data', (chunk: Buffer) => {
      received += chunk.length
    })
    guard.on('error', () => resolve({ refused: true, received }))
    guard.on('end', () => resolve({ refused: false, received }))
    for (let at = 0; at < bytes.length; at += 4096) guard.write(bytes.subarray(at, at + 4096))
    guard.end()
  })
}

function decoded(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const decoder = createDecompressStream()
    const out: Buffer[] = []
    decoder.on('data', (chunk: Buffer) => out.push(chunk))
    decoder.on('error', reject)
    decoder.on('end', () => resolve(Buffer.concat(out)))
    decoder.end(bytes)
  })
}

describe('XzGuard on every block of every stream', () => {
  const first = randomBytes(100_000)
  const second = randomBytes(3_000)

  it('builds streams that the real decoder reads, so the cases below are real xz', async () => {
    const both = stream([
      block(0, stored(first), first.length),
      block(0, stored(second), second.length),
    ])
    const bytes = Uint8Array.from(both.bytes)
    expect((await decoded(bytes)).equals(Buffer.concat([first, second]))).toBe(true)
    expect(await counted(bytes)).toEqual({ refused: false, received: bytes.length })
  })

  it('refuses a huge dictionary in the second block of a stream', async () => {
    const built = stream([block(0, packed(2_000), 4096), block(40, packed(2_000), 4096)])
    const result = await counted(Uint8Array.from(built.bytes))
    expect(result.refused).toBe(true)
    expect(result.received).toBeLessThanOrEqual(built.headers[1])
  })

  it('refuses a huge dictionary in the second of two streams', async () => {
    const one = stream([block(0, stored(second), second.length)]).bytes
    const two = stream([block(40, stored(second), second.length)])
    const result = await counted(Uint8Array.from([...one, ...two.bytes]))
    expect(result.refused).toBe(true)
    expect(result.received).toBeLessThanOrEqual(one.length + two.headers[0])
  })

  it('refuses a huge dictionary in a block after one of stored chunks', async () => {
    const built = stream([
      block(0, stored(first), first.length),
      block(40, stored(second), second.length),
    ])
    const result = await counted(Uint8Array.from(built.bytes))
    expect(result.refused).toBe(true)
    expect(result.received).toBeLessThanOrEqual(built.headers[1])
  })

  it('passes stream padding on as it comes instead of holding it', async () => {
    const packedTar = await xz(TAR)
    const guard = new XzGuard()
    let received = 0
    guard.on('data', (chunk: Buffer) => {
      received += chunk.length
    })
    const zeros = Buffer.alloc(768 * 1024)
    guard.write(packedTar)
    for (let at = 0; at < zeros.length; at += 16 * 1024)
      guard.write(zeros.subarray(at, at + 16 * 1024))
    await new Promise((resolve) => setImmediate(resolve))
    expect(received).toBe(packedTar.length + zeros.length)
    guard.end(packedTar)
    await new Promise((resolve) => guard.on('end', resolve))
    expect(received).toBe(2 * packedTar.length + zeros.length)
  })
})
