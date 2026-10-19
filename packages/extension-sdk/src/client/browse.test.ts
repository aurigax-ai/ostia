import { describe, expect, it } from 'vitest'
import { BROWSE_CACHE_BLOCKS, BROWSE_READ_MAX } from '../contract/fileBrowse'
import { blockCache } from './browse'

const MIB = BROWSE_READ_MAX

function source(size: number) {
  const calls: Array<[number, number]> = []
  const bytes = Uint8Array.from({ length: size }, (_unused, i) => i % 251)
  const cache = blockCache(size, async (start, length) => {
    calls.push([start, length])
    return bytes.slice(start, start + length)
  })
  return { cache, calls, bytes }
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of stream) parts.push(Buffer.from(part))
  return Buffer.concat(parts)
}

describe('blockCache', () => {
  it('asks the host only for whole aligned blocks, the last one short', async () => {
    const { cache, calls, bytes } = source(2 * MIB + 100)
    const small = await cache.readAt(5, 10)
    const across = await cache.readAt(MIB - 5, 10)
    const tail = await cache.readAt(2 * MIB + 90, 10)
    expect(Buffer.from(small)).toEqual(Buffer.from(bytes.subarray(5, 15)))
    expect(Buffer.from(across)).toEqual(Buffer.from(bytes.subarray(MIB - 5, MIB + 5)))
    expect(Buffer.from(tail)).toEqual(Buffer.from(bytes.subarray(2 * MIB + 90, 2 * MIB + 100)))
    expect(calls).toEqual([
      [0, MIB],
      [MIB, MIB],
      [2 * MIB, 100],
    ])
  })

  it('serves thousands of small reads from the blocks it holds', async () => {
    const { cache, calls } = source(3 * MIB)
    for (let at = 0; at < 3 * MIB - 64; at += 64) await cache.readAt(at, 64)
    expect(calls.length).toBe(3)
  })

  it('keeps at most eight blocks, dropping the least recently used', async () => {
    const blocks = BROWSE_CACHE_BLOCKS + 2
    const { cache, calls } = source(blocks * MIB)
    for (let i = 0; i < blocks; i++) await cache.readAt(i * MIB, 1)
    expect(calls.length).toBe(blocks)
    await cache.readAt((blocks - 1) * MIB, 1)
    expect(calls.length).toBe(blocks)
    await cache.readAt(0, 1)
    expect(calls.length).toBe(blocks + 1)
  })

  it('shares one request between reads that ask for the same block at once', async () => {
    const { cache, calls } = source(MIB)
    await Promise.all([cache.readAt(0, 10), cache.readAt(100, 10), cache.readAt(200, 10)])
    expect(calls.length).toBe(1)
  })

  it('refuses reads past the end or with bad numbers', async () => {
    const { cache } = source(100)
    await expect(cache.readAt(95, 10)).rejects.toThrow(RangeError)
    await expect(cache.readAt(-1, 1)).rejects.toThrow(RangeError)
    await expect(cache.readAt(1.5, 1)).rejects.toThrow(RangeError)
    expect((await cache.readAt(100, 0)).length).toBe(0)
  })

  it('streams a range through the same blocks and does not fetch past its end', async () => {
    const { cache, calls, bytes } = source(3 * MIB)
    const got = await drain(cache.stream(MIB - 10, MIB + 10))
    expect(got).toEqual(Buffer.from(bytes.subarray(MIB - 10, MIB + 10)))
    expect(calls).toEqual([
      [0, MIB],
      [MIB, MIB],
    ])
    expect((await drain(cache.stream())).length).toBe(3 * MIB)
  })
})
