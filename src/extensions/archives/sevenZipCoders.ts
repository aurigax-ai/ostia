import { type Duplex, PassThrough, pipeline, type Readable } from 'node:stream'
import type { BrowseFile } from '@aurigax-ai/ostia-extension-sdk'
import { BcjX86Decoder } from './bcjX86'
import { Counted, InflateLimit } from './inflate'
import {
  AES_ID,
  type Coder,
  type Folder,
  refuse,
  SevenZipRefused,
  SIGNATURE_HEADER_BYTES,
  type StreamsInfo,
} from './sevenZipHeader'
import { lzma2DictSize, XZ_DICT_MAX } from './xzGuard'

export interface Native {
  lzma: () => Duplex
  lzma2: (dictSize: number) => Duplex
}

export const nativeLzma: Native = {
  lzma: () => require('@napi-rs/lzma/lzma').createDecompressStream(),
  lzma2: (dictSize) => require('@napi-rs/lzma/lzma2').createDecompressStream({ dictSize }),
}

const COPY = '00'
const LZMA = '030101'
const LZMA2 = '21'
const BCJ_X86 = '03030103'
const LZMA_PROPS_BYTES = 5
const LZMA_MAX_PROPS_BYTE = 224

const NAMES: Record<string, string> = {
  '0303011b': 'BCJ2',
  '030401': 'PPMd',
  '040108': 'Deflate',
  '040109': 'Deflate64',
  '040202': 'BZip2',
  '03030205': 'PowerPC',
  '03030401': 'IA64',
  '03030501': 'ARM',
  '03030701': 'ARM Thumb',
  '03030805': 'SPARC',
  '0a': 'ARM64',
  '0b': 'RISC-V',
  '03': 'Delta',
}

function lzmaDict(props: Uint8Array): number {
  if (props.length !== LZMA_PROPS_BYTES || props[0] > LZMA_MAX_PROPS_BYTE) {
    refuse('corrupt', '7z: bad LZMA properties')
  }
  return (props[1] | (props[2] << 8) | (props[3] << 16) | (props[4] << 24)) >>> 0
}

function lzma2Dict(props: Uint8Array): number {
  if (props.length !== 1 || props[0] > 40) refuse('corrupt', '7z: bad LZMA2 properties')
  return lzma2DictSize(props[0])
}

function checkDictionary(size: number): void {
  if (size > XZ_DICT_MAX) refuse('unsupported', '7z: dictionary over 64 MiB')
}

function checkCoder(coder: Coder): void {
  if (coder.id === COPY || coder.id === BCJ_X86 || coder.id === AES_ID) return
  if (coder.id === LZMA) checkDictionary(lzmaDict(coder.props))
  else if (coder.id === LZMA2) checkDictionary(lzma2Dict(coder.props))
  else refuse('unsupported', `7z: the ${NAMES[coder.id] ?? `coder ${coder.id}`} coder is not read`)
}

export function checkFolder(folder: Folder): void {
  for (const coder of folder.coders) checkCoder(coder)
}

export function isEncrypted(folder: Folder): boolean {
  return folder.coders.some((coder) => coder.id === AES_ID)
}

function stageOf(coder: Coder, unpackSize: number, native: Native): Duplex {
  if (coder.id === COPY) return new PassThrough()
  if (coder.id === BCJ_X86) return new BcjX86Decoder()
  if (coder.id === LZMA2) return native.lzma2(lzma2Dict(coder.props))
  if (coder.id === LZMA) {
    const header = Buffer.alloc(13)
    header.set(coder.props, 0)
    header.writeBigUInt64LE(BigInt(unpackSize), 5)
    const stage = native.lzma()
    stage.write(header)
    return stage
  }
  return refuse('encrypted', '7z: encrypted data')
}

export function packRange(streams: StreamsInfo, folder: number): { start: number; end: number } {
  let start = SIGNATURE_HEADER_BYTES + streams.packPos
  for (let i = 0; i < folder; i++) start += streams.packSizes[i]
  return { start, end: start + streams.packSizes[folder] }
}

export type FolderEnd = 'done' | 'stopped'

export interface FolderRun {
  file: BrowseFile
  streams: StreamsInfo
  folder: number
  budget: number
  scanMs: number
  signal: AbortSignal
  native: Native
}

export async function decodeFolder(
  run: FolderRun,
  onChunk: (chunk: Buffer, at: number) => boolean | Promise<boolean>,
): Promise<FolderEnd> {
  const { file, streams, folder: index, signal } = run
  const folder = streams.folders[index]
  const { start, end } = packRange(streams, index)
  if (start < SIGNATURE_HEADER_BYTES || end > file.size) {
    refuse('corrupt', '7z: a packed stream outside the file')
  }
  if (signal.aborted) throw new SevenZipRefused('corrupt', 'cancelled')
  const packed: Readable = file.stream(start, end)
  const stages = folder.chain.map((at) =>
    stageOf(folder.coders[at], folder.unpackSizes[at], run.native),
  )
  const output = new Counted(run.budget)
  const all = [packed, ...stages, output]
  const finish = (error?: Error): void => {
    for (const stream of all) stream.destroy(error)
  }
  pipeline(all as [Readable, ...Duplex[]], () => {})
  const timer = setTimeout(() => finish(new Error('scan time')), run.scanMs)
  const abort = (): void => finish(new Error('cancelled'))
  signal.addEventListener('abort', abort, { once: true })
  let at = 0
  try {
    for await (const chunk of output) {
      if (!(await onChunk(chunk as Buffer, at))) return 'stopped'
      at += (chunk as Buffer).length
    }
    return 'done'
  } catch (error) {
    if (signal.aborted) throw new SevenZipRefused('corrupt', 'cancelled')
    if (error instanceof InflateLimit || (error as Error).message === 'scan time') {
      throw new SevenZipRefused('limit', '7z: decoded output over the limit')
    }
    if (error instanceof SevenZipRefused) throw error
    throw new SevenZipRefused('corrupt', '7z: the data does not decode')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    finish()
  }
}
