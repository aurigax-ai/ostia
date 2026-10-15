import { constants, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { FolderAnchor } from './folderAnchor'
import type { TransferFs } from './transferFs'

export interface TransferEnd {
  anchor: FolderAnchor
  name: string
}

export type CopyClaim = 'done' | 'taken'

export type MoveClaim = CopyClaim | 'copy'

export class PartialTransferError extends Error {
  constructor(readonly path: string) {
    super('partial')
  }
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const MODE_BITS = 0o777
const COPY_CHUNK_BYTES = 1024 * 1024

type Claim = 'taken' | { fill: () => Promise<void> }

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function sameEntry(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function pathOf(end: TransferEnd): string {
  return join(end.anchor.path, end.name)
}

async function closeAll(handles: { close: () => Promise<void> }[]): Promise<void> {
  const results = await Promise.allSettled(handles.map((handle) => handle.close()))
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) throw failed.reason
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

async function claimFile(
  fs: TransferFs,
  from: string,
  to: string,
  expected: Stats,
): Promise<Claim> {
  const input = await fs.open(from, READ_FLAGS)
  try {
    const info = await input.stat()
    if (!info.isFile() || !sameEntry(expected, info)) throw new Error('source-replaced')
    const output = await fs.open(to, CREATE_FLAGS, info.mode & MODE_BITS).catch((error) => {
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
          await closeAll([output, input])
        }
      },
    }
  } catch (error) {
    await input.close()
    throw error
  }
}

async function claimFolder(
  fs: TransferFs,
  source: TransferEnd,
  target: TransferEnd,
  expected: Stats,
): Promise<Claim> {
  if (!(await claimed(async () => fs.mkdir(await target.anchor.at(target.name))))) return 'taken'
  return {
    fill: async () => {
      const made = await fs.lstat(await target.anchor.at(target.name))
      const from = await source.anchor.child(source.name, expected)
      try {
        const into = await target.anchor.child(target.name, made)
        try {
          await copyChildren(fs, from, into)
        } finally {
          await into.close()
        }
      } finally {
        await from.close()
      }
    },
  }
}

async function claimTarget(
  fs: TransferFs,
  source: TransferEnd,
  target: TransferEnd,
): Promise<Claim | null> {
  const from = await source.anchor.at(source.name)
  const stat = await fs.lstat(from)
  if (stat.isSymbolicLink()) {
    const destination = await fs.readlink(from)
    const made = await claimed(async () =>
      fs.symlink(destination, await target.anchor.at(target.name)),
    )
    return made ? { fill: async () => {} } : 'taken'
  }
  if (stat.isDirectory()) return claimFolder(fs, source, target, stat)
  if (stat.isFile()) return claimFile(fs, from, await target.anchor.at(target.name), stat)
  return null
}

async function copyChildren(fs: TransferFs, from: FolderAnchor, into: FolderAnchor): Promise<void> {
  for (const name of await from.list()) {
    const claim = await claimTarget(fs, { anchor: from, name }, { anchor: into, name })
    if (claim === null) continue
    if (claim === 'taken') throw new Error('exists')
    await claim.fill()
  }
}

export async function copyExclusive(
  fs: TransferFs,
  source: TransferEnd,
  target: TransferEnd,
): Promise<CopyClaim> {
  const claim = await claimTarget(fs, source, target)
  if (claim === null) throw new Error('not-copyable')
  if (claim === 'taken') return 'taken'
  try {
    await claim.fill()
    return 'done'
  } catch {
    throw new PartialTransferError(pathOf(target))
  }
}

async function placeholder(fs: TransferFs, target: TransferEnd, folder: boolean): Promise<boolean> {
  const to = await target.anchor.at(target.name)
  if (folder) return claimed(() => fs.mkdir(to))
  return claimed(async () => (await fs.open(to, CREATE_FLAGS, 0o600)).close())
}

export async function moveExclusive(
  fs: TransferFs,
  source: TransferEnd,
  target: TransferEnd,
  platform: NodeJS.Platform,
): Promise<MoveClaim> {
  const info = await fs.lstat(await source.anchor.at(source.name))
  const folder = info.isDirectory()
  if ((folder && platform === 'win32') || info.dev !== target.anchor.stat.dev) return 'copy'
  if (!(await placeholder(fs, target, folder))) return 'taken'
  try {
    await fs.rename(await source.anchor.at(source.name), await target.anchor.at(target.name))
    return 'done'
  } catch {
    throw new PartialTransferError(pathOf(target))
  }
}

export async function entryUnchanged(
  fs: TransferFs,
  end: TransferEnd,
  expected: Stats,
): Promise<boolean> {
  if (!(await end.anchor.stillAt())) return false
  const now = await fs.lstat(await end.anchor.at(end.name)).catch(() => null)
  return now !== null && sameEntry(expected, now)
}
