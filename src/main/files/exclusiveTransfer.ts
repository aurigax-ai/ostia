import { constants, type Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface TransferFs {
  lstat: (path: string) => Promise<Stats>
  readdir: (path: string) => Promise<string[]>
  readlink: (path: string) => Promise<string>
  mkdir: (path: string) => Promise<unknown>
  symlink: (target: string, path: string) => Promise<void>
  open: typeof open
  rename: (from: string, to: string) => Promise<void>
  rmdir: (path: string) => Promise<void>
  unlink: (path: string) => Promise<void>
}

export const nodeTransferFs: TransferFs = {
  lstat: (path) => lstat(path),
  readdir: (path) => readdir(path),
  readlink: (path) => readlink(path),
  mkdir: (path) => mkdir(path),
  symlink: (target, path) => symlink(target, path),
  open,
  rename,
  rmdir: (path) => rmdir(path),
  unlink,
}

export interface TransferOptions {
  parent: Stats
  fs?: TransferFs
  platform?: NodeJS.Platform
}

export type CopyClaim = 'done' | 'taken'

export type MoveClaim = CopyClaim | 'copy'

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const MODE_BITS = 0o777
const COPY_CHUNK_BYTES = 1024 * 1024

type Claim = 'taken' | { fill: () => Promise<void> }

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function isSameFolder(made: Stats, now: Stats): boolean {
  return now.isDirectory() && made.dev === now.dev && made.ino === now.ino
}

async function claimed(create: () => Promise<unknown>): Promise<boolean> {
  try {
    await create()
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
}

async function checkFolder(fs: TransferFs, path: string, expected: Stats): Promise<void> {
  if (!isSameFolder(expected, await fs.lstat(path))) throw new Error('folder-replaced')
}

async function claimFile(fs: TransferFs, source: string, target: string): Promise<Claim> {
  const input = await fs.open(source, READ_FLAGS)
  try {
    const info = await input.stat()
    if (!info.isFile()) throw new Error('not-a-file')
    const output = await fs.open(target, CREATE_FLAGS, info.mode & MODE_BITS).catch((error) => {
      if (errorCode(error) === 'EEXIST') return null
      throw error
    })
    if (output === null) {
      await input.close()
      return 'taken'
    }
    return {
      fill: async () => {
        try {
          const buffer = Buffer.alloc(COPY_CHUNK_BYTES)
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
            if (bytesRead === 0) break
            for (let written = 0; written < bytesRead; ) {
              written += (await output.write(buffer, written, bytesRead - written)).bytesWritten
            }
          }
        } finally {
          await output.close()
          await input.close()
        }
      },
    }
  } catch (error) {
    await input.close()
    throw error
  }
}

async function claimTarget(fs: TransferFs, source: string, target: string): Promise<Claim | null> {
  const stat = await fs.lstat(source)
  if (stat.isSymbolicLink()) {
    const destination = await fs.readlink(source)
    return (await claimed(() => fs.symlink(destination, target)))
      ? { fill: async () => {} }
      : 'taken'
  }
  if (stat.isDirectory()) {
    if (!(await claimed(() => fs.mkdir(target)))) return 'taken'
    const made = await fs.lstat(target)
    return { fill: () => copyChildren(fs, source, target, made) }
  }
  if (stat.isFile()) return claimFile(fs, source, target)
  return null
}

async function copyChildren(
  fs: TransferFs,
  source: string,
  target: string,
  made: Stats,
): Promise<void> {
  for (const name of await fs.readdir(source)) {
    await checkFolder(fs, target, made)
    const claim = await claimTarget(fs, join(source, name), join(target, name))
    if (claim === null) continue
    if (claim === 'taken') throw new Error('exists')
    await claim.fill()
  }
}

export async function copyExclusive(
  source: string,
  target: string,
  discard: (path: string) => Promise<void>,
  { parent, fs = nodeTransferFs }: TransferOptions,
): Promise<CopyClaim> {
  await checkFolder(fs, dirname(target), parent)
  const claim = await claimTarget(fs, source, target)
  if (claim === null) throw new Error('not-copyable')
  if (claim === 'taken') return 'taken'
  try {
    await claim.fill()
    return 'done'
  } catch (error) {
    await discard(target).catch(() => {})
    throw error
  }
}

async function placeholder(fs: TransferFs, target: string, folder: boolean): Promise<boolean> {
  if (folder) return claimed(() => fs.mkdir(target))
  return claimed(async () => (await fs.open(target, CREATE_FLAGS, 0o600)).close())
}

export async function moveExclusive(
  source: string,
  target: string,
  { parent, fs = nodeTransferFs, platform = process.platform }: TransferOptions,
): Promise<MoveClaim> {
  const folder = (await fs.lstat(source)).isDirectory()
  if (folder && platform === 'win32') return 'copy'
  await checkFolder(fs, dirname(target), parent)
  if (!(await placeholder(fs, target, folder))) return 'taken'
  try {
    await fs.rename(source, target)
    return 'done'
  } catch (error) {
    await (folder ? fs.rmdir(target) : fs.unlink(target)).catch(() => {})
    if (errorCode(error) === 'EXDEV') return 'copy'
    throw error
  }
}
