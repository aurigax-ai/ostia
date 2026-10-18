import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Bzip2Decoder, Bzip2Error } from './bzip2'

function bzip2(bytes: Uint8Array, level = 9): Buffer {
  return execFileSync('bzip2', [`-${level}`, '-c'], { input: bytes, maxBuffer: 64 * 1024 * 1024 })
}

function decode(packed: Uint8Array, chunk = packed.length || 1, out = 65_536): Buffer {
  const decoder = new Bzip2Decoder()
  const parts: Buffer[] = []
  const buffer = new Uint8Array(out)
  for (let at = 0; at < packed.length; at += chunk) {
    decoder.push(packed.subarray(at, at + chunk))
    for (let n = decoder.read(buffer); n; n = decoder.read(buffer)) {
      parts.push(Buffer.from(buffer.subarray(0, n)))
    }
  }
  decoder.end()
  for (let n = decoder.read(buffer); n !== null; n = decoder.read(buffer)) {
    parts.push(Buffer.from(buffer.subarray(0, n)))
  }
  return Buffer.concat(parts)
}

function problem(packed: Uint8Array): string {
  try {
    decode(packed)
  } catch (err) {
    if (err instanceof Bzip2Error) return err.problem
    throw err
  }
  return 'none'
}

const TEXT = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(3000))

describe('Bzip2Decoder', () => {
  it('decodes what bzip2 wrote, from one chunk or many small ones', () => {
    for (const data of [Buffer.from('a'), TEXT, randomBytes(70_000)]) {
      const packed = bzip2(data)
      expect(decode(packed).equals(data)).toBe(true)
      expect(decode(packed, 7, 13).equals(data)).toBe(true)
    }
  })

  it('decodes several blocks, long runs and every byte value', () => {
    const data = Buffer.concat([
      randomBytes(150_000),
      Buffer.alloc(300_000, 0x41),
      Buffer.from(Array.from({ length: 256 * 40 }, (_unused, i) => i & 0xff)),
      TEXT,
    ])
    expect(decode(bzip2(data, 1)).equals(data)).toBe(true)
  })

  it('decodes streams written one after another, as pbzip2 does', () => {
    const packed = Buffer.concat([bzip2(TEXT.subarray(0, 5000)), bzip2(TEXT.subarray(5000))])
    expect(decode(packed, 4096).equals(TEXT)).toBe(true)
  })

  it('refuses a wrong magic, a cut stream and an empty input', () => {
    expect(problem(Buffer.from('not bzip2 at all'))).toBe('format')
    expect(problem(Buffer.from('BZh0rest'))).toBe('format')
    const packed = bzip2(TEXT)
    expect(problem(packed.subarray(0, Math.floor(packed.length / 2)))).toBe('truncated')
    expect(problem(packed.subarray(0, packed.length - 3))).toBe('truncated')
    expect(problem(Buffer.alloc(0))).toBe('truncated')
  })

  it('refuses a block whose CRC does not match and a stream whose CRC does not', () => {
    const block = bzip2(TEXT)
    block[10] ^= 0x01
    expect(problem(block)).toBe('crc')
    const stream = bzip2(TEXT)
    stream[stream.length - 2] ^= 0x10
    expect(problem(stream)).toBe('crc')
  })

  it('hands out no byte of a block before its CRC is checked', () => {
    const block = bzip2(TEXT)
    block[10] ^= 0x01
    const decoder = new Bzip2Decoder()
    decoder.push(block)
    decoder.end()
    const out = new Uint8Array(1000).fill(0xaa)
    expect(() => decoder.read(out)).toThrow(new Bzip2Error('crc'))
    expect(out.every((byte) => byte === 0xaa)).toBe(true)
  })

  it('refuses a damaged block body without throwing anything else', () => {
    const packed = bzip2(TEXT)
    for (const at of [20, 40, 80, Math.floor(packed.length / 2)]) {
      const damaged = Buffer.from(packed)
      damaged[at] ^= 0xff
      expect(['format', 'crc', 'truncated']).toContain(problem(damaged))
    }
  })

  it('hands out a large block in pieces the size it is asked for', () => {
    const decoder = new Bzip2Decoder()
    decoder.push(bzip2(Buffer.alloc(4 * 1024 * 1024)))
    decoder.end()
    const out = new Uint8Array(1000)
    expect(decoder.read(out)).toBe(1000)
    expect(decoder.read(out)).toBe(1000)
  })
})
