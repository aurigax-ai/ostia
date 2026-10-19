import { Readable } from 'node:stream'
import {
  type BrowseContext,
  type BrowseEntry,
  BrowseError,
  type BrowseFile,
  type BrowseLimits,
  type BrowseProvider,
} from '@aurigax-ai/ostia-extension-sdk'
import { BROWSE_LIMITS } from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'

const PIECE = 16 * 1024

export interface MemoryFile extends BrowseFile {
  served: number
  streams: Readable[]
}

export function memoryFile(bytes: Uint8Array): MemoryFile {
  const file: MemoryFile = {
    size: bytes.length,
    served: 0,
    streams: [],
    readAt: async (offset, length) => bytes.subarray(offset, offset + length),
    stream: (start = 0, end = bytes.length) => {
      async function* pieces(): AsyncGenerator<Uint8Array> {
        for (let at = start; at < end; at += PIECE) {
          const piece = bytes.subarray(at, Math.min(end, at + PIECE))
          file.served += piece.length
          yield piece
        }
      }
      const stream = Readable.from(pieces(), { objectMode: false })
      file.streams.push(stream)
      return stream
    },
  }
  return file
}

type ListOutcome = { entries: BrowseEntry[]; result: Awaited<ReturnType<BrowseProvider['list']>> }

export async function listAll(
  provider: BrowseProvider,
  file: BrowseFile,
  limits: BrowseLimits = BROWSE_LIMITS,
  signal: AbortSignal = new AbortController().signal,
): Promise<ListOutcome> {
  const entries: BrowseEntry[] = []
  const context: BrowseContext = { signal, limits }
  const result = await provider
    .list(
      file,
      {
        add: async (entry) => {
          entries.push(entry)
          return entries.length <= limits.entries
        },
      },
      context,
    )
    .catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof BrowseError ? (err.code as 'corrupt') : ('failed' as const),
    }))
  return { entries, result }
}

export async function readEntry(
  provider: BrowseProvider,
  file: BrowseFile,
  index: number,
  max = 1024 * 1024,
  limits: BrowseLimits = BROWSE_LIMITS,
): Promise<{ data: Buffer; result: Awaited<ReturnType<BrowseProvider['read']>> }> {
  const parts: Buffer[] = []
  let total = 0
  const result = await provider
    .read(
      file,
      index,
      {
        write: async (bytes) => {
          total += bytes.length
          if (total > max) return false
          parts.push(Buffer.from(bytes))
          return true
        },
      },
      { signal: new AbortController().signal, limits, max },
    )
    .catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof BrowseError ? (err.code as 'corrupt') : ('failed' as const),
    }))
  return { data: Buffer.concat(parts), result }
}
