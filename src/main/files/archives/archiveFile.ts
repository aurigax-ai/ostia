import { constants, closeSync, fstatSync, openSync } from 'node:fs'
import type { ArchiveEntryProblem } from '../../../shared/types'

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export type EntryRead =
  | { ok: true; data: Buffer }
  | { ok: false; problem: ArchiveEntryProblem | 'too-large' | 'unreadable'; size?: number }

export async function openRegular(path: string): Promise<number | null> {
  let fd: number
  try {
    fd = openSync(path, READ_FLAGS)
  } catch {
    return null
  }
  try {
    if (fstatSync(fd).isFile()) return fd
  } catch {}
  closeSync(fd)
  return null
}

interface ByteSource {
  on: (event: string, listener: (value: Buffer) => void) => unknown
  destroy?: () => unknown
}

export function collect(
  stream: ByteSource,
  max: number,
): Promise<{ ok: true; data: Buffer } | { ok: false; overflow: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > max) {
        stream.destroy?.()
        resolve({ ok: false, overflow: true })
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', () => resolve({ ok: false, overflow: true }))
    stream.on('end', () => resolve({ ok: true, data: Buffer.concat(chunks) }))
  })
}
