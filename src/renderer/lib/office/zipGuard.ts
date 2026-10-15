import { Inflate } from 'fflate'
import type { OfficeLimits } from './officeLimits'

export type ZipVerdict = 'ok' | 'unzip-limit' | 'failed'

const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50
const CHUNK_BYTES = 16 * 1024

class OverLimit extends Error {}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8)
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && u32(bytes, 0) === LOCAL_HEADER
}

function directoryEnd(bytes: Uint8Array): number {
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (u32(bytes, at) === END_OF_DIRECTORY) return at
  }
  return -1
}

function storedSize(
  bytes: Uint8Array,
  header: number,
  extraStart: number,
  extraLength: number,
): number {
  let size = u32(bytes, header + 18)
  for (let at = extraStart; at + 4 <= extraStart + extraLength; ) {
    const id = u16(bytes, at)
    const length = u16(bytes, at + 2)
    if (id === 1 && length >= 16) size = u32(bytes, at + 12) + u32(bytes, at + 16) * 2 ** 32
    at += 4 + length
  }
  return size
}

interface Budget {
  left: number
}

function inflatedSize(
  bytes: Uint8Array,
  start: number,
  budget: Budget,
  limits: OfficeLimits,
): boolean {
  let produced = 0
  let pushed = 0
  let done = false
  const inflate = new Inflate((chunk, final) => {
    produced += chunk.length
    budget.left -= chunk.length
    if (budget.left < 0) throw new OverLimit()
    if (produced > limits.ratioFloorBytes && produced > pushed * limits.entryRatio) {
      throw new OverLimit()
    }
    if (final) done = true
  })
  for (let at = start; at < bytes.length && !done; at += CHUNK_BYTES) {
    const end = Math.min(at + CHUNK_BYTES, bytes.length)
    pushed += end - at
    inflate.push(bytes.subarray(at, end), end === bytes.length)
  }
  return done
}

function checkEntry(
  bytes: Uint8Array,
  offset: number,
  budget: Budget,
  limits: OfficeLimits,
): boolean {
  if (offset + 30 > bytes.length || u32(bytes, offset) !== LOCAL_HEADER) return false
  const method = u16(bytes, offset + 8)
  const nameLength = u16(bytes, offset + 26)
  const extraLength = u16(bytes, offset + 28)
  const extraStart = offset + 30 + nameLength
  const start = extraStart + extraLength
  if (start > bytes.length) return false
  if (method === 0) {
    budget.left -= Math.min(
      storedSize(bytes, offset, extraStart, extraLength),
      bytes.length - start,
    )
    if (budget.left < 0) throw new OverLimit()
    return true
  }
  if (method !== 8) return false
  return inflatedSize(bytes, start, budget, limits)
}

export function checkZip(bytes: Uint8Array, limits: OfficeLimits): ZipVerdict {
  const end = directoryEnd(bytes)
  if (end < 0) return 'failed'
  const entries = u16(bytes, end + 8)
  if (entries > limits.entries) return 'unzip-limit'
  const budget: Budget = { left: limits.inflatedBytes }
  let at = u32(bytes, end + 16)
  try {
    for (let i = 0; i < entries; i++) {
      if (at + 46 > bytes.length || u32(bytes, at) !== DIRECTORY_ENTRY) return 'failed'
      if (!checkEntry(bytes, u32(bytes, at + 42), budget, limits)) return 'failed'
      at += 46 + u16(bytes, at + 28) + u16(bytes, at + 30) + u16(bytes, at + 32)
    }
  } catch (error) {
    return error instanceof OverLimit ? 'unzip-limit' : 'failed'
  }
  return 'ok'
}
