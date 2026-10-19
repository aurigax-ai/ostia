import { crc32 } from 'node:zlib'

const SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]
export const SIGNATURE_HEADER_BYTES = 32
export const PACKED_HEADER_MAX = 16 * 1024 * 1024
export const DECODED_HEADER_MAX = 64 * 1024 * 1024
const FOLDERS_MAX = 20_000
export const LISTED_MAX = 80_004
const CODERS_MAX = 4

export type Refusal = 'unsupported' | 'corrupt' | 'encrypted' | 'limit'

export class SevenZipRefused extends Error {
  constructor(
    readonly code: Refusal,
    message: string,
  ) {
    super(message)
  }
}

export function refuse(code: Refusal, message: string): never {
  throw new SevenZipRefused(code, message)
}

const K = {
  end: 0x00,
  header: 0x01,
  archiveProperties: 0x02,
  additionalStreamsInfo: 0x03,
  mainStreamsInfo: 0x04,
  filesInfo: 0x05,
  packInfo: 0x06,
  unpackInfo: 0x07,
  subStreamsInfo: 0x08,
  size: 0x09,
  crc: 0x0a,
  folder: 0x0b,
  codersUnpackSize: 0x0c,
  numUnpackStream: 0x0d,
  emptyStream: 0x0e,
  emptyFile: 0x0f,
  anti: 0x10,
  name: 0x11,
  winAttributes: 0x15,
  encodedHeader: 0x17,
} as const

const FILE_PROPERTIES = new Set<number>([
  K.emptyStream,
  K.emptyFile,
  K.anti,
  K.name,
  K.winAttributes,
])

export const AES_ID = '06f10701'

export interface Coder {
  id: string
  props: Uint8Array
}

export interface Folder {
  coders: Coder[]
  chain: number[]
  unpackSizes: number[]
  crc: number | null
}

export interface StreamsInfo {
  packPos: number
  packSizes: number[]
  folders: Folder[]
  streamCounts: number[]
  streamSizes: number[]
  streamCrcs: Array<number | null>
}

interface FileRecord {
  name: string
  emptyStream: boolean
  emptyFile: boolean
  anti: boolean
  attributes: number | null
}

export interface HeaderScan {
  deadline: number
  signal: AbortSignal
}

function check(scan: HeaderScan): void {
  if (scan.signal.aborted) refuse('corrupt', 'cancelled')
  if (Date.now() >= scan.deadline) refuse('limit', '7z: reading the header took too long')
}

function once(seen: Set<number>, type: number): void {
  if (seen.has(type)) refuse('corrupt', `7z: property ${type} appears twice`)
  seen.add(type)
}

export interface ParsedHeader {
  streams: StreamsInfo | null
  files: FileRecord[]
  fileCount: number
}

class Bytes {
  at = 0

  constructor(readonly data: Uint8Array) {}

  get left(): number {
    return this.data.length - this.at
  }

  u8(): number {
    if (this.at >= this.data.length) refuse('corrupt', '7z: cut header')
    return this.data[this.at++]
  }

  u32(): number {
    if (this.left < 4) refuse('corrupt', '7z: cut header')
    const d = this.data
    const at = this.at
    this.at += 4
    return (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0
  }

  take(count: number): Uint8Array {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.left) {
      refuse('corrupt', '7z: field longer than the header')
    }
    const out = this.data.subarray(this.at, this.at + count)
    this.at += count
    return out
  }

  number(): number {
    const first = this.u8()
    let mask = 0x80
    let value = 0
    for (let i = 0; i < 8; i++) {
      if ((first & mask) === 0) {
        value += (first & (mask - 1)) * 2 ** (8 * i)
        return safe(value)
      }
      value += this.u8() * 2 ** (8 * i)
      mask >>= 1
    }
    return safe(value)
  }

  count(limit: number): number {
    const value = this.number()
    if (value > limit) refuse('corrupt', '7z: a count is larger than the header can hold')
    return value
  }

  vector(count: number): BitVector {
    return { bytes: this.take(Math.ceil(count / 8)), count }
  }

  defined(count: number): BitVector {
    return this.u8() === 0 ? this.vector(count) : { bytes: null, count }
  }
}

interface BitVector {
  bytes: Uint8Array | null
  count: number
}

function bitAt(vector: BitVector, index: number): boolean {
  return vector.bytes === null ? true : (vector.bytes[index >> 3] & (0x80 >> (index & 7))) !== 0
}

function ones(vector: BitVector): number {
  if (vector.bytes === null) return vector.count
  let total = 0
  const whole = vector.count >> 3
  for (let i = 0; i < whole; i++) total += POPCOUNT[vector.bytes[i]]
  for (let i = whole << 3; i < vector.count; i++) if (bitAt(vector, i)) total++
  return total
}

const POPCOUNT = Uint8Array.from({ length: 256 }, (_unused, byte) => {
  let bits = 0
  for (let rest = byte; rest; rest >>= 1) bits += rest & 1
  return bits
})

function safe(value: number): number {
  if (!Number.isSafeInteger(value)) refuse('corrupt', '7z: a number is over 2^53')
  return value
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

export function crcOf(bytes: Uint8Array): number {
  return crc32(bytes) >>> 0
}

function digests(bytes: Bytes, count: number, keep: number): Array<number | null> {
  const defined = bytes.defined(count)
  const out: Array<number | null> = []
  for (let i = 0; i < count; i++) {
    const crc = bitAt(defined, i) ? bytes.u32() : null
    if (out.length < keep) out.push(crc)
  }
  return out
}

function readCoder(bytes: Bytes): Coder {
  const flags = bytes.u8()
  if (flags & 0x80) refuse('unsupported', '7z: alternative coder methods')
  const id = hex(bytes.take(flags & 0x0f))
  if (flags & 0x10) {
    const inStreams = bytes.number()
    const outStreams = bytes.number()
    if (inStreams !== 1 || outStreams !== 1) {
      refuse('unsupported', `7z: coder ${id} has ${inStreams} inputs and ${outStreams} outputs`)
    }
  }
  const props = flags & 0x20 ? bytes.take(bytes.count(bytes.left)) : new Uint8Array(0)
  return { id, props }
}

function readFolder(bytes: Bytes): Omit<Folder, 'unpackSizes' | 'crc'> {
  const count = bytes.count(bytes.left)
  if (count < 1 || count > CODERS_MAX) {
    refuse('unsupported', `7z: ${count} coders in one folder`)
  }
  const coders: Coder[] = []
  for (let i = 0; i < count; i++) coders.push(readCoder(bytes))
  const pairs: Array<{ inIndex: number; outIndex: number }> = []
  for (let i = 0; i < count - 1; i++) {
    pairs.push({ inIndex: bytes.count(count - 1), outIndex: bytes.count(count - 1) })
  }
  const packed = count - pairs.length
  if (packed !== 1) refuse('unsupported', '7z: a folder with several packed streams')
  const bound = new Set(pairs.map((pair) => pair.inIndex))
  let at = [...Array(count).keys()].find((index) => !bound.has(index))
  if (at === undefined) refuse('corrupt', '7z: a folder without a packed input')
  const chain: number[] = []
  while (at !== undefined) {
    if (chain.includes(at)) refuse('corrupt', '7z: a coder loop')
    chain.push(at)
    const here: number = at
    at = pairs.find((pair) => pair.outIndex === here)?.inIndex
  }
  if (chain.length !== count) refuse('unsupported', '7z: a folder that is not a single chain')
  return { coders, chain }
}

function readStreams(bytes: Bytes, headerSize: number, scan: HeaderScan): StreamsInfo {
  let packPos = 0
  let packSizes: number[] = []
  let folders: Folder[] = []
  let streamCounts: number[] = []
  let streamSizes: number[] = []
  let streamCrcs: Array<number | null> = []
  let haveSubStreams = false
  const seen = new Set<number>()
  for (let type = bytes.u8(); type !== K.end; type = bytes.u8()) {
    check(scan)
    once(seen, type)
    if (type === K.packInfo) {
      packPos = bytes.number()
      const count = bytes.count(FOLDERS_MAX)
      packSizes = []
      for (let id = bytes.u8(); id !== K.end; id = bytes.u8()) {
        if (id === K.size) for (let i = 0; i < count; i++) packSizes.push(bytes.number())
        else if (id === K.crc) digests(bytes, count, count)
        else refuse('corrupt', '7z: unknown pack info property')
      }
      if (packSizes.length !== count) refuse('corrupt', '7z: pack sizes missing')
    } else if (type === K.unpackInfo) {
      folders = readUnpackInfo(bytes, headerSize)
    } else if (type === K.subStreamsInfo) {
      haveSubStreams = true
      const info = readSubStreams(bytes, folders)
      streamCounts = info.counts
      streamSizes = info.sizes
      streamCrcs = info.crcs
    } else refuse('corrupt', `7z: unknown streams property ${type}`)
  }
  if (!haveSubStreams) {
    streamCounts = folders.map(() => 1)
    streamSizes = folders.map(unpackSize)
    streamCrcs = folders.map((folder) => folder.crc)
  }
  return { packPos, packSizes, folders, streamCounts, streamSizes, streamCrcs }
}

export function unpackSize(folder: Folder): number {
  return folder.unpackSizes[folder.chain[folder.chain.length - 1]]
}

function readUnpackInfo(bytes: Bytes, headerSize: number): Folder[] {
  if (bytes.u8() !== K.folder) refuse('corrupt', '7z: folders expected')
  const count = bytes.count(Math.min(headerSize, FOLDERS_MAX))
  if (bytes.u8() !== 0) refuse('unsupported', '7z: external folder data')
  const shapes = Array.from({ length: count }, () => readFolder(bytes))
  if (bytes.u8() !== K.codersUnpackSize) refuse('corrupt', '7z: unpack sizes expected')
  const folders: Folder[] = shapes.map((shape) => ({
    ...shape,
    unpackSizes: shape.coders.map(() => bytes.number()),
    crc: null,
  }))
  for (let id = bytes.u8(); id !== K.end; id = bytes.u8()) {
    if (id !== K.crc) refuse('corrupt', '7z: unknown unpack info property')
    digests(bytes, count, count).forEach((crc, i) => {
      folders[i].crc = crc
    })
  }
  return folders
}

function readSubStreams(
  bytes: Bytes,
  folders: Folder[],
): { counts: number[]; sizes: number[]; crcs: Array<number | null> } {
  let counts = folders.map(() => 1)
  let type = bytes.u8()
  if (type === K.numUnpackStream) {
    counts = folders.map(() => bytes.number())
    type = bytes.u8()
  }
  const sizes: number[] = []
  const keep = (size: number): void => {
    if (sizes.length < LISTED_MAX) sizes.push(size)
  }
  const hasSizes = type === K.size
  folders.forEach((folder, i) => {
    const n = counts[i]
    if (n === 0) return
    let sum = 0
    if (hasSizes) {
      for (let k = 0; k < n - 1; k++) {
        const size = bytes.number()
        keep(size)
        sum += size
      }
    } else if (n > 1) refuse('corrupt', '7z: substream sizes missing')
    const rest = unpackSize(folder) - sum
    if (rest < 0) refuse('corrupt', '7z: substream sizes over the folder size')
    keep(rest)
  })
  if (hasSizes) type = bytes.u8()
  const unknown = folders.reduce(
    (total, folder, i) => total + (counts[i] === 1 && folder.crc !== null ? 0 : counts[i]),
    0,
  )
  let read: Array<number | null> = []
  while (type !== K.end) {
    if (type !== K.crc) refuse('corrupt', '7z: unknown substreams property')
    read = digests(bytes, unknown, LISTED_MAX)
    type = bytes.u8()
  }
  const crcs: Array<number | null> = []
  let at = 0
  for (let i = 0; i < folders.length && crcs.length < LISTED_MAX; i++) {
    if (counts[i] === 1 && folders[i].crc !== null) {
      crcs.push(folders[i].crc)
      continue
    }
    for (let k = 0; k < counts[i] && crcs.length < LISTED_MAX; k++) crcs.push(read[at++] ?? null)
  }
  return { counts, sizes, crcs }
}

function readNames(bytes: Bytes, size: number, count: number): string[] {
  const end = bytes.at + size
  if (bytes.u8() !== 0) refuse('unsupported', '7z: external file names')
  const raw = bytes.take(end - bytes.at)
  const names: string[] = []
  let from = 0
  for (let at = 0; at + 1 < raw.length && names.length < count; at += 2) {
    if (raw[at] === 0 && raw[at + 1] === 0) {
      names.push(Buffer.from(raw.subarray(from, at)).toString('utf16le'))
      from = at + 2
    }
  }
  if (names.length !== count) refuse('corrupt', '7z: fewer names than files')
  return names
}

function readFiles(
  bytes: Bytes,
  headerLeft: number,
  scan: HeaderScan,
): { files: FileRecord[]; count: number } {
  const count = bytes.count(headerLeft)
  const kept = Math.min(count, LISTED_MAX)
  const files: FileRecord[] = Array.from({ length: kept }, () => ({
    name: '',
    emptyStream: false,
    emptyFile: false,
    anti: false,
    attributes: null,
  }))
  let emptyStream: BitVector | null = null
  let emptyFile: BitVector | null = null
  let anti: BitVector | null = null
  const seen = new Set<number>()
  for (let type = bytes.u8(); type !== K.end; type = bytes.u8()) {
    check(scan)
    const size = bytes.number()
    const end = bytes.at + size
    if (size > bytes.left) refuse('corrupt', '7z: a file property is longer than the header')
    if (FILE_PROPERTIES.has(type)) once(seen, type)
    if (type === K.emptyStream) {
      emptyStream = bytes.vector(count)
    } else if (type === K.emptyFile) {
      emptyFile = bytes.vector(emptyStream ? ones(emptyStream) : 0)
    } else if (type === K.anti) {
      anti = bytes.vector(emptyStream ? ones(emptyStream) : 0)
    } else if (type === K.name) {
      readNames(bytes, size, kept).forEach((name, i) => {
        files[i].name = name
      })
    } else if (type === K.winAttributes) {
      const defined = bytes.defined(count)
      if (bytes.u8() !== 0) refuse('unsupported', '7z: external attributes')
      for (let i = 0; i < kept; i++) {
        if (bitAt(defined, i)) files[i].attributes = bytes.u32()
      }
    }
    if (bytes.at > end) refuse('corrupt', '7z: a file property is longer than it says')
    bytes.at = end
  }
  let empties = 0
  files.forEach((file, i) => {
    if (!emptyStream || !bitAt(emptyStream, i)) return
    file.emptyStream = true
    file.emptyFile = emptyFile ? bitAt(emptyFile, empties) : false
    file.anti = anti ? bitAt(anti, empties) : false
    empties++
  })
  return { files, count }
}

export function parseHeader(block: Uint8Array, headerSize: number, scan: HeaderScan): ParsedHeader {
  const bytes = new Bytes(block)
  if (bytes.u8() !== K.header) refuse('corrupt', '7z: header expected')
  let streams: StreamsInfo | null = null
  let files: FileRecord[] = []
  let fileCount = 0
  const seen = new Set<number>()
  for (let type = bytes.u8(); type !== K.end; type = bytes.u8()) {
    check(scan)
    once(seen, type)
    if (type === K.archiveProperties) {
      for (let id = bytes.u8(); id !== K.end; id = bytes.u8()) bytes.take(bytes.count(bytes.left))
    } else if (type === K.additionalStreamsInfo) {
      refuse('unsupported', '7z: additional streams')
    } else if (type === K.mainStreamsInfo) {
      streams = readStreams(bytes, headerSize, scan)
    } else if (type === K.filesInfo) {
      const read = readFiles(bytes, bytes.left, scan)
      files = read.files
      fileCount = read.count
    } else refuse('corrupt', `7z: unknown header property ${type}`)
  }
  return { streams, files, fileCount }
}

export function parseEncodedHeader(block: Uint8Array, scan: HeaderScan): StreamsInfo {
  const bytes = new Bytes(block)
  if (bytes.u8() !== K.encodedHeader) refuse('corrupt', '7z: encoded header expected')
  return readStreams(bytes, block.length, scan)
}

export function isEncodedHeader(block: Uint8Array): boolean {
  return block[0] === K.encodedHeader
}

export interface StartHeader {
  nextOffset: number
  nextSize: number
  nextCrc: number
}

export function parseStartHeader(head: Uint8Array): StartHeader {
  if (head.length < SIGNATURE_HEADER_BYTES) refuse('corrupt', '7z: shorter than its header')
  if (!SIGNATURE.every((byte, i) => head[i] === byte)) refuse('unsupported', 'not a 7z file')
  if (head[6] !== 0 || head[7] > 4) refuse('unsupported', '7z: version')
  const bytes = new Bytes(head)
  bytes.at = 8
  if (bytes.u32() !== crcOf(head.subarray(12, SIGNATURE_HEADER_BYTES))) {
    refuse('corrupt', '7z: start header CRC')
  }
  const nextOffset = safe(bytes.u32() + bytes.u32() * 2 ** 32)
  const nextSize = safe(bytes.u32() + bytes.u32() * 2 ** 32)
  return { nextOffset, nextSize, nextCrc: bytes.u32() }
}
