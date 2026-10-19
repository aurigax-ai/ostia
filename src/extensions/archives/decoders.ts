import { join } from 'node:path'
import { Bzip2Stream } from './bzip2Stream'
import type { Decoders } from './inflate'

type XzModule = typeof import('@napi-rs/lzma/xz')

function loadXz(): XzModule {
  return require('@napi-rs/lzma/xz')
}

export function decodersIn(dir: string, load: () => XzModule = loadXz): Decoders {
  return {
    xz: () => load().createDecompressStream(),
    bzip2: () => new Bzip2Stream(join(dir, 'bzip2.thread.js')),
  }
}
