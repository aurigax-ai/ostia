import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AtomicWriteOptions {
  mode?: number
  dirMode?: number
}

function tempPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
}

function tempOptions(opts: AtomicWriteOptions) {
  return { encoding: 'utf8' as const, flag: 'wx', mode: opts.mode ?? 0o666 }
}

export function writeFileAtomic(path: string, text: string, opts: AtomicWriteOptions = {}): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: opts.dirMode ?? 0o777 })
  if (opts.dirMode !== undefined) chmodSync(dir, opts.dirMode)
  const tmp = tempPath(path)
  try {
    writeFileSync(tmp, text, tempOptions(opts))
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

export async function writeFileAtomicAsync(
  path: string,
  text: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: opts.dirMode ?? 0o777 })
  if (opts.dirMode !== undefined) await chmod(dir, opts.dirMode)
  const tmp = tempPath(path)
  try {
    await writeFile(tmp, text, tempOptions(opts))
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
