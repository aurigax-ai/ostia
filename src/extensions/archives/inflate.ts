import { type Duplex, type Readable, Transform } from 'node:stream'
import { createGunzip, createZstdDecompress } from 'node:zlib'
import { XzGuard } from './xzGuard'

const GZIP = [0x1f, 0x8b]
const ZSTD = [0x28, 0xb5, 0x2f, 0xfd]
const XZ = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]
const BZIP2 = [0x42, 0x5a, 0x68]
const BZIP2_BLOCKS = [
  [0x31, 0x41, 0x59, 0x26, 0x53, 0x59],
  [0x17, 0x72, 0x45, 0x38, 0x50, 0x90],
]

export const SNIFF_BYTES = 10

export type Compression = 'gzip' | 'zstd' | 'xz' | 'bzip2'

export interface Decoders {
  xz: () => Duplex
  bzip2: () => Duplex
}

export class InflateLimit extends Error {}

function hasMagic(head: Uint8Array, magic: number[]): boolean {
  return head.length >= magic.length && magic.every((byte, at) => head[at] === byte)
}

function isBzip2(head: Uint8Array): boolean {
  const level = head[BZIP2.length] ?? 0
  const block = head.subarray(BZIP2.length + 1)
  return (
    hasMagic(head, BZIP2) &&
    level >= 0x31 &&
    level <= 0x39 &&
    BZIP2_BLOCKS.some((magic) => hasMagic(block, magic))
  )
}

function isCompressed(head: Uint8Array): boolean {
  return hasMagic(head, GZIP) || hasMagic(head, ZSTD) || hasMagic(head, XZ) || isBzip2(head)
}

export function sniffCompression(head: Uint8Array): Compression | null {
  if (hasMagic(head, GZIP)) return 'gzip'
  if (hasMagic(head, ZSTD)) return 'zstd'
  if (hasMagic(head, XZ)) return 'xz'
  return isBzip2(head) ? 'bzip2' : null
}

class Budget extends Transform {
  private total = 0
  private first = true

  constructor(private readonly limit: number) {
    super()
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null, data?: Buffer) => void,
  ): void {
    if (this.first) {
      this.first = false
      if (isCompressed(chunk)) {
        done(new Error('nested compression'))
        return
      }
    }
    this.total += chunk.length
    if (this.total > this.limit) {
      done(new InflateLimit('decompressed output over the limit'))
      return
    }
    done(null, chunk)
  }
}

function budgeted(
  input: Readable,
  stages: Duplex[],
  limit: number,
): { output: Readable; stages: Readable[] } {
  const budget = new Budget(limit)
  let tail: Readable = input
  for (const stage of stages) tail = tail.pipe(stage)
  tail.pipe(budget)
  return { output: budget, stages: [...stages, budget] }
}

export function inflate(
  input: Readable,
  kind: Compression,
  limit: number,
  decoders: Decoders,
): { output: Readable; stages: Readable[] } {
  if (kind === 'gzip') return budgeted(input, [createGunzip()], limit)
  if (kind === 'zstd') return budgeted(input, [createZstdDecompress()], limit)
  if (kind === 'xz') return budgeted(input, [new XzGuard(), decoders.xz()], limit)
  return budgeted(input, [decoders.bzip2()], limit)
}
