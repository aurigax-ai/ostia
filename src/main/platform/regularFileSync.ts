import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export type RegularFileRead =
  | { ok: true; body: Buffer }
  | { ok: false; error: 'unreadable' | 'not-a-file' | 'moved' | 'too-large' }

export function readRegularFileSync(path: string, maxBytes: number): RegularFileRead {
  let fd: number
  try {
    fd = openSync(path, READ_FLAGS)
  } catch {
    return { ok: false, error: 'unreadable' }
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile()) return { ok: false, error: 'not-a-file' }
    const now = statSync(path)
    if (realpathSync(path) !== path || now.dev !== opened.dev || now.ino !== opened.ino) {
      return { ok: false, error: 'moved' }
    }
    if (opened.size > maxBytes) return { ok: false, error: 'too-large' }
    const body = Buffer.alloc(opened.size)
    let read = 0
    while (read < body.length) {
      const bytes = readSync(fd, body, read, body.length - read, read)
      if (bytes === 0) break
      read += bytes
    }
    return { ok: true, body: body.subarray(0, read) }
  } catch {
    return { ok: false, error: 'unreadable' }
  } finally {
    closeSync(fd)
  }
}
