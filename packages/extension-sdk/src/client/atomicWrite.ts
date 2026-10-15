import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { chmod, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface AtomicWriteOptions {
  mode?: number
  dirMode?: number
}

const TEMP_NAME = /^(.+)\.(\d+)\.[0-9a-f]{16}\.tmp$/

function tempPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function staleTemps(path: string, names: string[]): string[] {
  const base = basename(path)
  return names
    .filter((name) => {
      const match = TEMP_NAME.exec(name)
      if (match?.[1] !== base) return false
      const pid = Number(match[2])
      return pid !== process.pid && !running(pid)
    })
    .map((name) => join(dirname(path), name))
}

export function writeFileAtomic(path: string, text: string, opts: AtomicWriteOptions = {}): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: opts.dirMode ?? 0o777 })
  if (opts.dirMode !== undefined) chmodSync(dir, opts.dirMode)
  for (const stale of staleTemps(path, readdirSync(dir))) rmSync(stale, { force: true })
  const tmp = tempPath(path)
  const fd = openSync(tmp, 'wx', opts.mode ?? 0o666)
  try {
    try {
      writeFileSync(fd, text, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
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
  const stale = staleTemps(path, await readdir(dir))
  await Promise.all(stale.map((file) => rm(file, { force: true })))
  const tmp = tempPath(path)
  const handle = await open(tmp, 'wx', opts.mode ?? 0o666)
  try {
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
