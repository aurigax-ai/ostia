import { read } from 'node:fs'
import { type Readable, Transform } from 'node:stream'
import { createGunzip, createZstdDecompress } from 'node:zlib'

const GZIP = [0x1f, 0x8b]
const ZSTD = [0x28, 0xb5, 0x2f, 0xfd]
const SNIFF_BYTES = 4

export class InflateLimit extends Error {}

function hasMagic(head: Uint8Array, magic: number[]): boolean {
  return head.length >= magic.length && magic.every((byte, at) => head[at] === byte)
}

function isCompressed(head: Uint8Array): boolean {
  return hasMagic(head, GZIP) || hasMagic(head, ZSTD)
}

export function sniffCompression(fd: number): Promise<'gzip' | 'zstd' | null> {
  return new Promise((resolve) => {
    read(fd, Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0, (error, bytes, head) => {
      const seen = error ? head.subarray(0, 0) : head.subarray(0, bytes)
      if (hasMagic(seen, GZIP)) resolve('gzip')
      else resolve(hasMagic(seen, ZSTD) ? 'zstd' : null)
    })
  })
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

export function inflate(
  input: Readable,
  kind: 'gzip' | 'zstd',
  limit: number,
): { output: Readable; stages: Readable[] } {
  const decoder = kind === 'gzip' ? createGunzip() : createZstdDecompress()
  const budget = new Budget(limit)
  input.pipe(decoder).pipe(budget)
  return { output: budget, stages: [decoder, budget] }
}
