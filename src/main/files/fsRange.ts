import { constants } from 'node:fs'
import { type FileHandle, lstat, open } from 'node:fs/promises'

export const RANGE_CHUNK_MAX = 1024 * 1024

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

export interface RangeReader {
  size: number
  read: () => Promise<Uint8Array | null>
  close: () => Promise<void>
}

export type FsRangeResult =
  | { ok: true; reader: RangeReader }
  | { ok: false; error: 'denied' | 'unreadable' | 'unsatisfiable' }

function readerOf(handle: FileHandle, size: number, start: number, end: number): RangeReader {
  let position = start
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await handle.close().catch(() => undefined)
  }
  return {
    size,
    close,
    read: async () => {
      if (closed || position > end) return null
      const length = Math.min(RANGE_CHUNK_MAX, end - position + 1)
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead < length) {
        await close()
        throw new Error('file shrank while it was read')
      }
      position += length
      return buffer
    },
  }
}

export async function readRangeConfined(
  path: unknown,
  start: number,
  end: number,
  confine: (path: string) => string | null,
): Promise<FsRangeResult> {
  if (typeof path !== 'string') return { ok: false, error: 'denied' }
  const safe = confine(path)
  if (safe === null) return { ok: false, error: 'denied' }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return { ok: false, error: 'unsatisfiable' }
  }
  let handle: FileHandle | null = null
  try {
    const listed = await lstat(safe)
    if (!listed.isFile()) return { ok: false, error: 'unreadable' }
    handle = await open(safe, OPEN_FLAGS)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino) {
      await handle.close()
      return { ok: false, error: 'unreadable' }
    }
    if (end >= opened.size) {
      await handle.close()
      return { ok: false, error: 'unsatisfiable' }
    }
    return { ok: true, reader: readerOf(handle, opened.size, start, end) }
  } catch {
    await handle?.close().catch(() => undefined)
    return { ok: false, error: 'unreadable' }
  }
}
