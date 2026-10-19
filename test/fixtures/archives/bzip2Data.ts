import { tarOf } from './archives'

export const TEXT = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(3000))

export function seeded(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length)
  let state = seed >>> 0 || 1
  for (let i = 0; i < length; i++) {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    out[i] = state & 0xff
  }
  return out
}

export function manyBlocks(): Buffer {
  return Buffer.from(Array.from({ length: 40_000 }, (_unused, i) => `line ${i % 997}\n`).join(''))
}

export function mixed(): Buffer {
  return Buffer.concat([
    seeded(6000, 3),
    Buffer.alloc(300_000, 0x41),
    Buffer.from(Array.from({ length: 256 * 40 }, (_unused, i) => i & 0xff)),
    TEXT,
  ])
}

export const DOCS_ITEMS = [
  { name: 'docs/readme.txt', data: 'hello' },
  { name: 'passwd', type: '2' as const, link: '../../etc/passwd' },
]

export const DOCS_TAR = tarOf(DOCS_ITEMS, false)

export function bigEntryTar(): Buffer {
  const header = tarOf([{ name: 'big.bin', size: 64 * 1024 * 1024 }], false).subarray(0, 512)
  return Buffer.concat([header, Buffer.alloc(64 * 1024 * 1024), Buffer.alloc(1024)])
}

export const BZIP2_SOURCES: Record<string, { data: () => Uint8Array; level: number }> = {
  'a.bz2': { data: () => Buffer.from('a'), level: 9 },
  'text.bz2': { data: () => TEXT, level: 9 },
  'text-head.bz2': { data: () => TEXT.subarray(0, 5000), level: 9 },
  'text-tail.bz2': { data: () => TEXT.subarray(5000), level: 9 },
  'noise.bz2': { data: () => seeded(8000, 1), level: 9 },
  'blocks.bz2': { data: manyBlocks, level: 1 },
  'mixed.bz2': { data: mixed, level: 1 },
  'zeros4m.bz2': { data: () => Buffer.alloc(4 * 1024 * 1024), level: 9 },
  'a64m.bz2': { data: () => Buffer.alloc(64 * 1024 * 1024, 0x41), level: 9 },
  'bigentry.tar.bz2': { data: bigEntryTar, level: 9 },
  'docs-link.tar.bz2': { data: () => DOCS_TAR, level: 9 },
}
