import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function privateTmpDir(name: string): string {
  if (process.platform === 'win32') {
    const dir = join(tmpdir(), name)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const uid = process.getuid?.() ?? 0
  const dir = join(tmpdir(), `${name}-${uid}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) {
    throw new Error(`refusing to use ${dir}: not a directory owned by uid ${uid}`)
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700)
  return dir
}
