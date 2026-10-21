import { constants, lstatSync, realpathSync, type Stats } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { isHiddenFromPhone } from '../gateway/workspaceFiles'
import { isInsidePath } from '../platform/pathGuard'

export interface PreviewSource {
  file: string
  root: string | null
}

export type PreviewFile = { ok: true; path: string; size: number } | { ok: false; status: number }

export function regularFileSize(path: string): number | null {
  try {
    const st = lstatSync(path)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

export function resolvePreviewFile(source: PreviewSource, pathname: string): PreviewFile {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { ok: false, status: 400 }
  }
  if (decoded === '/' || decoded === '') {
    const size = regularFileSize(source.file)
    return size === null ? { ok: false, status: 404 } : { ok: true, path: source.file, size }
  }
  if (!source.root || decoded.includes('\0')) return { ok: false, status: 404 }
  const lexical = join(source.root, decoded)
  if (
    isInsidePath(lexical, source.root) ||
    !isInsidePath(source.root, lexical) ||
    isHiddenFromPhone(relative(source.root, lexical))
  ) {
    return { ok: false, status: 404 }
  }
  const size = regularFileSize(lexical)
  if (size === null) return { ok: false, status: 404 }
  let folder: string
  try {
    folder = realpathSync(dirname(lexical))
  } catch {
    return { ok: false, status: 404 }
  }
  if (!isInsidePath(source.root, folder)) {
    return { ok: false, status: 404 }
  }
  const path = join(folder, basename(lexical))
  if (isHiddenFromPhone(relative(source.root, path))) return { ok: false, status: 404 }
  return { ok: true, path, size }
}

export type PreviewRead = { ok: true; path: string; body: Buffer } | { ok: false; status: number }

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

async function stillAt(path: string, opened: Stats): Promise<boolean> {
  try {
    return (await realpath(path)) === path && sameFile(await stat(path), opened)
  } catch {
    return false
  }
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export async function readRegularFile(path: string, maxBytes: number): Promise<PreviewRead> {
  const handle = await open(path, READ_FLAGS).catch(() => null)
  if (!handle) return { ok: false, status: 404 }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !(await stillAt(path, opened))) return { ok: false, status: 404 }
    if (opened.size > maxBytes) return { ok: false, status: 413 }
    const body = Buffer.alloc(opened.size)
    let read = 0
    while (read < body.length) {
      const { bytesRead } = await handle.read(body, read, body.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { ok: true, path, body: body.subarray(0, read) }
  } catch {
    return { ok: false, status: 404 }
  } finally {
    await handle.close()
  }
}

export async function readPreviewFile(
  source: PreviewSource,
  pathname: string,
  maxBytes: number,
): Promise<PreviewRead> {
  const found = resolvePreviewFile(source, pathname)
  return found.ok ? readRegularFile(found.path, maxBytes) : found
}
