import { Inflate } from 'fflate'
import { GuardStop, type OfficeLimits } from './officeLimits'

export type EntrySink = (chunk: Uint8Array, final: boolean) => void

const END_OF_DIRECTORY = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50
const ZIP64_EXTRA = 0x0001
const ENCRYPTED_FLAGS = 0x2041
const DATA_DESCRIPTOR = 0x0008
const MAX_32 = 0xffffffff
const MAX_16 = 0xffff
const TAIL_BYTES = 65_557
const CHUNK_BYTES = 16 * 1024

function u16(bytes: Uint8Array, at: number): number {
  return at + 2 <= bytes.length ? bytes[at] | (bytes[at + 1] << 8) : -1
}

function u32(bytes: Uint8Array, at: number): number {
  if (at + 4 > bytes.length) return -1
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
}

function fail(): never {
  throw new GuardStop('failed')
}

export function isZip(bytes: Uint8Array): boolean {
  return u32(bytes, 0) === LOCAL_HEADER
}

function directoryEnd(bytes: Uint8Array): number {
  for (let at = bytes.length - 4; at >= 0; at--) {
    if (u32(bytes, at) === END_OF_DIRECTORY) return at
  }
  return -1
}

function hasZip64Extra(bytes: Uint8Array, start: number, length: number): boolean {
  for (let at = start; at + 4 <= start + length; at += 4 + u16(bytes, at + 2)) {
    if (u16(bytes, at) === ZIP64_EXTRA) return true
  }
  return false
}

function sameBytes(bytes: Uint8Array, a: number, b: number, length: number): boolean {
  for (let i = 0; i < length; i++) if (bytes[a + i] !== bytes[b + i]) return false
  return true
}

interface Entry {
  name: string
  method: number
  start: number
  storedBytes: number
  declared: number
}

function readEnd(
  bytes: Uint8Array,
  limits: OfficeLimits,
): { count: number; offset: number; end: number } {
  const end = directoryEnd(bytes)
  if (end < 0 || end + 22 + u16(bytes, end + 20) !== bytes.length) fail()
  for (let at = Math.max(0, bytes.length - TAIL_BYTES); at < end; at++) {
    if (u32(bytes, at) === END_OF_DIRECTORY) fail()
  }
  const count = u16(bytes, end + 8)
  const size = u32(bytes, end + 12)
  const offset = u32(bytes, end + 16)
  if (u16(bytes, end + 4) !== 0 || u16(bytes, end + 6) !== 0) fail()
  if (count !== u16(bytes, end + 10) || count === MAX_16) fail()
  if (offset === MAX_32 || size === MAX_32 || offset + size !== end) fail()
  if (end >= 20 && u32(bytes, end - 20) === ZIP64_LOCATOR) fail()
  if (count > limits.entries) throw new GuardStop('unzip-limit')
  return { count, offset, end }
}

function readEntry(bytes: Uint8Array, at: number, decoder: TextDecoder): [Entry, number] {
  if (u32(bytes, at) !== DIRECTORY_ENTRY) fail()
  const flags = u16(bytes, at + 8)
  const method = u16(bytes, at + 10)
  const compressed = u32(bytes, at + 20)
  const size = u32(bytes, at + 24)
  const nameLength = u16(bytes, at + 28)
  const extraLength = u16(bytes, at + 30)
  const commentLength = u16(bytes, at + 32)
  const local = u32(bytes, at + 42)
  const nameAt = at + 46
  if (flags & ENCRYPTED_FLAGS) throw new GuardStop('encrypted')
  if ([compressed, size, local].includes(MAX_32)) fail()
  if (hasZip64Extra(bytes, nameAt + nameLength, extraLength)) fail()
  if (u32(bytes, local) !== LOCAL_HEADER) fail()
  const localFlags = u16(bytes, local + 6)
  const localCompressed = u32(bytes, local + 18)
  const localSize = u32(bytes, local + 22)
  const localNameLength = u16(bytes, local + 26)
  const localExtraLength = u16(bytes, local + 28)
  if (localFlags & ENCRYPTED_FLAGS) throw new GuardStop('encrypted')
  if (u16(bytes, local + 8) !== method || localNameLength !== nameLength) fail()
  if (!sameBytes(bytes, nameAt, local + 30, nameLength)) fail()
  if (hasZip64Extra(bytes, local + 30 + nameLength, localExtraLength)) fail()
  if (!(localFlags & DATA_DESCRIPTOR) && (localCompressed !== compressed || localSize !== size)) {
    fail()
  }
  if ([localCompressed, localSize].includes(MAX_32)) fail()
  const start = local + 30 + nameLength + localExtraLength
  if (start > bytes.length) fail()
  const entry: Entry = {
    name: decoder.decode(bytes.subarray(nameAt, nameAt + nameLength)),
    method,
    start,
    storedBytes: Math.min(localCompressed, bytes.length - start),
    declared: Math.max(size, localSize),
  }
  return [entry, nameAt + nameLength + extraLength + commentLength]
}

interface Budget {
  left: number
}

function charge(budget: Budget, bytes: number): void {
  budget.left -= bytes
  if (budget.left < 0) throw new GuardStop('unzip-limit')
}

function inflateEntry(
  bytes: Uint8Array,
  entry: Entry,
  budget: Budget,
  limits: OfficeLimits,
  sink: EntrySink | null,
): void {
  charge(budget, entry.declared)
  if (entry.method === 0) {
    charge(budget, Math.max(0, entry.storedBytes - entry.declared))
    sink?.(bytes.subarray(entry.start, entry.start + entry.storedBytes), true)
    return
  }
  if (entry.method !== 8) fail()
  let produced = 0
  let pushed = 0
  let done = false
  const inflate = new Inflate((chunk, final) => {
    const before = produced
    produced += chunk.length
    charge(budget, Math.max(0, produced - Math.max(before, entry.declared)))
    if (produced > limits.ratioFloorBytes && produced > pushed * limits.entryRatio) {
      throw new GuardStop('unzip-limit')
    }
    sink?.(chunk, final)
    if (final) done = true
  })
  for (let at = entry.start; at < bytes.length && !done; at += CHUNK_BYTES) {
    const end = Math.min(at + CHUNK_BYTES, bytes.length)
    pushed += end - at
    inflate.push(bytes.subarray(at, end), end === bytes.length)
  }
  if (!done) fail()
}

export function checkCanonicalZip(
  bytes: Uint8Array,
  limits: OfficeLimits,
  sinkFor: (name: string) => EntrySink | null = () => null,
): void {
  const decoder = new TextDecoder()
  const { count, offset, end } = readEnd(bytes, limits)
  const budget: Budget = { left: limits.inflatedBytes }
  let at = offset
  for (let i = 0; i < count; i++) {
    const [entry, next] = readEntry(bytes, at, decoder)
    inflateEntry(bytes, entry, budget, limits, sinkFor(entry.name))
    at = next
  }
  if (at !== end) fail()
}

const COMPOUND_FILE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ENCRYPTED_PACKAGE = new TextEncoder().encode('EncryptedPackage')

function isCompoundFile(bytes: Uint8Array): boolean {
  return COMPOUND_FILE.every((byte, i) => bytes[i] === byte)
}

function holdsUtf16(bytes: Uint8Array, ascii: Uint8Array): boolean {
  outer: for (let at = 0; at + ascii.length * 2 <= bytes.length; at++) {
    for (let i = 0; i < ascii.length; i++) {
      if (bytes[at + i * 2] !== ascii[i] || bytes[at + i * 2 + 1] !== 0) continue outer
    }
    return true
  }
  return false
}

export function checkOfficeContainer(
  bytes: Uint8Array,
  limits: OfficeLimits,
  sinkFor?: (name: string) => EntrySink | null,
): void {
  if (bytes.length > limits.fileBytes) throw new GuardStop('too-large')
  if (isCompoundFile(bytes)) {
    throw new GuardStop(holdsUtf16(bytes, ENCRYPTED_PACKAGE) ? 'encrypted' : 'failed')
  }
  if (!isZip(bytes)) throw new GuardStop('failed')
  checkCanonicalZip(bytes, limits, sinkFor)
}
