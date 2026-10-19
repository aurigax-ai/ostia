import { join } from 'node:path'
import { createDecompressStream } from '@napi-rs/lzma/xz'
import { Bzip2Stream } from './bzip2Stream'
import type { Decoders } from './inflate'

export function decodersIn(dir: string): Decoders {
  return {
    xz: createDecompressStream,
    bzip2: () => new Bzip2Stream(join(dir, 'bzip2.thread.js')),
  }
}
