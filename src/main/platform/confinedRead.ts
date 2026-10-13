import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isInsideDir } from './pathGuard'

export type FileRead = { ok: true; data: Buffer } | { ok: false; error: string }

export function readConfined(root: string, path: string, maxBytes: number): FileRead {
  if (!isInsideDir(root, path)) return { ok: false, error: 'outside the extension' }
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    return { ok: false, error: 'missing' }
  }
  if (st.isSymbolicLink()) return { ok: false, error: 'symlink refused' }
  if (!st.isFile()) return { ok: false, error: 'not a file' }
  if (st.size > maxBytes) return { ok: false, error: `larger than ${maxBytes} bytes` }
  try {
    if (!isInsideDir(root, realpathSync(path))) return { ok: false, error: 'outside the extension' }
    return { ok: true, data: readFileSync(path) }
  } catch {
    return { ok: false, error: 'unreadable' }
  }
}
