import type { Stats } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import type { FsTextResult } from '../../shared/types'
import { FS_BINARY_MAX } from './fsBinary'

export const FS_TEXT_SNIFF_BYTES = 8192

export interface FileStamp {
  ino: number
  mtimeMs: number
  size: number
}

export function stampOf(info: Stats): FileStamp {
  return { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size }
}

export function versionOf(stamp: FileStamp): string {
  return `${stamp.ino}:${stamp.mtimeMs}:${stamp.size}`
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export async function readTextConfined(
  path: unknown,
  confine: (path: string) => string | null,
  max: number = FS_BINARY_MAX,
): Promise<FsTextResult> {
  if (typeof path !== 'string') return { ok: false, error: 'denied' }
  const safe = confine(path)
  if (safe === null) return { ok: false, error: 'denied' }
  try {
    const info = await stat(safe)
    if (!info.isFile()) return { ok: false, error: 'unreadable' }
    if (info.size > max) return { ok: false, error: 'too-large', size: info.size }
    const data = await readFile(safe)
    if (data.byteLength > max) return { ok: false, error: 'too-large', size: data.byteLength }
    if (data.subarray(0, FS_TEXT_SNIFF_BYTES).includes(0)) return { ok: false, error: 'binary' }
    return { ok: true, text: data.toString('utf8'), version: versionOf(stampOf(info)) }
  } catch (err) {
    return { ok: false, error: isMissing(err) ? 'missing' : 'unreadable' }
  }
}

export async function versionConfined(
  path: unknown,
  confine: (path: string) => string | null,
): Promise<string | null> {
  if (typeof path !== 'string') return null
  const safe = confine(path)
  if (safe === null) return null
  try {
    const info = await stat(safe)
    return info.isFile() ? versionOf(stampOf(info)) : null
  } catch {
    return null
  }
}

export async function writeText(path: string, text: string): Promise<FileStamp> {
  const file = await open(path, 'w')
  try {
    await file.writeFile(text, 'utf8')
    return stampOf(await file.stat())
  } finally {
    await file.close()
  }
}
