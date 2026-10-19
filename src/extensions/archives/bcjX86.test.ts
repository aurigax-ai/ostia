import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BcjX86Decoder, BcjX86State, bcjX86Convert } from './bcjX86'

function decode(data: Uint8Array): Buffer {
  const out = Buffer.from(data)
  bcjX86Convert(out, new BcjX86State(), false)
  return out
}

function encode(data: Uint8Array): Buffer {
  const out = Buffer.from(data)
  bcjX86Convert(out, new BcjX86State(), true)
  return out
}

async function decodeInChunks(data: Uint8Array, chunk: number): Promise<Buffer> {
  const decoder = new BcjX86Decoder()
  const parts: Buffer[] = []
  decoder.on('data', (part: Buffer) => parts.push(part))
  const done = new Promise((resolve) => decoder.on('end', resolve))
  for (let at = 0; at < data.length; at += chunk) decoder.write(data.subarray(at, at + chunk))
  decoder.end()
  await done
  return Buffer.concat(parts)
}

describe('BCJ x86', () => {
  it('turns the absolute address of a CALL back into the relative one, by hand', () => {
    const encoded = Buffer.from([0xe8, 0x10, 0x00, 0x00, 0x00, 0x90, 0x90, 0x90, 0x90, 0x90])
    expect([...decode(encoded)]).toEqual([
      0xe8, 0x0b, 0x00, 0x00, 0x00, 0x90, 0x90, 0x90, 0x90, 0x90,
    ])
    const later = Buffer.from([
      0x90, 0x90, 0x90, 0xe9, 0x20, 0x01, 0x00, 0x00, 0x90, 0x90, 0x90, 0x90,
    ])
    expect([...decode(later)]).toEqual([
      0x90, 0x90, 0x90, 0xe9, 0x18, 0x01, 0x00, 0x00, 0x90, 0x90, 0x90, 0x90,
    ])
  })

  it('sign-extends a negative displacement and leaves other opcodes and the last four bytes alone', () => {
    const encoded = Buffer.from([0xe8, 0x04, 0xff, 0xff, 0xff, 0x90, 0x90, 0x90, 0x90, 0x90])
    expect([...decode(encoded)]).toEqual([
      0xe8, 0xff, 0xfe, 0xff, 0xff, 0x90, 0x90, 0x90, 0x90, 0x90,
    ])
    const plain = Buffer.from('no calls in this text at all')
    expect(decode(plain).equals(plain)).toBe(true)
    const tail = Buffer.from([0x90, 0x90, 0xe8, 0x01, 0x00, 0x00])
    expect(decode(tail).equals(tail)).toBe(true)
    expect(bcjX86Convert(Buffer.from([0xe8, 1, 2]), new BcjX86State(), false)).toBe(0)
  })

  it('round trips random and call-heavy data, whole and in any chunking', async () => {
    const calls = Buffer.concat(
      Array.from({ length: 400 }, (_unused, i) =>
        Buffer.concat([
          Buffer.from([i % 3 === 0 ? 0xe9 : 0xe8]),
          randomBytes(2),
          Buffer.from([i % 2 ? 0x00 : 0xff, i % 5 ? 0x00 : 0xff]),
          randomBytes(i % 7),
        ]),
      ),
    )
    for (const original of [randomBytes(5000), calls]) {
      const encoded = encode(original)
      expect(decode(encoded).equals(original)).toBe(true)
      for (const chunk of [1, 3, 4, 5, 7, 64, 1000]) {
        expect((await decodeInChunks(encoded, chunk)).equals(original), `chunk ${chunk}`).toBe(true)
      }
    }
  })
})
