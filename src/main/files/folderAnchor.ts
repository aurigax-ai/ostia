import { constants } from 'node:fs'
import { join } from 'node:path'
import { FD_DIR } from './atTransferFs'
import type { EntryStat, OpenFile, TransferFs } from './transferFs'

const PROC_FD_DIR = '/proc/self/fd'
const ANCHOR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

export interface FolderAnchor {
  readonly path: string
  readonly stat: EntryStat
  at: (name: string) => Promise<string>
  list: () => Promise<string[]>
  child: (name: string, expected: EntryStat) => Promise<FolderAnchor>
  stillAt: () => Promise<boolean>
  close: () => Promise<void>
}

function sameIdentity(a: EntryStat, b: EntryStat | null): boolean {
  return b?.isDirectory() === true && a.dev === b.dev && a.ino === b.ino
}

function replaced(): Error {
  return new Error('folder-replaced')
}

async function statOrNull(fs: TransferFs, path: string): Promise<EntryStat | null> {
  return fs.lstat(path).catch(() => null)
}

function handleAnchor(
  fs: TransferFs,
  fdDir: string,
  handle: OpenFile,
  path: string,
  info: EntryStat,
): FolderAnchor {
  const base = `${fdDir}/${handle.fd}`
  return {
    path,
    stat: info,
    at: async (name) => `${base}/${name}`,
    list: () => fs.readdir(base),
    child: (name, expected) =>
      openHandleAnchor(fs, fdDir, `${base}/${name}`, join(path, name), expected, false),
    stillAt: async () => sameIdentity(info, await statOrNull(fs, path)),
    close: () => handle.close(),
  }
}

function folded(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

async function vouches(
  fs: TransferFs,
  fdDir: string,
  handle: OpenFile,
  path: string,
  info: EntryStat,
): Promise<boolean> {
  const actual = await fs.readlink(`${fdDir}/${handle.fd}`)
  if (actual === path) return true
  return (
    fdDir === FD_DIR &&
    folded(actual) === folded(path) &&
    sameIdentity(info, await statOrNull(fs, path))
  )
}

async function openHandleAnchor(
  fs: TransferFs,
  fdDir: string,
  openPath: string,
  path: string,
  expected: EntryStat | null,
  checkPath: boolean,
): Promise<FolderAnchor> {
  const handle = await fs.open(openPath, ANCHOR_FLAGS)
  try {
    const info = await handle.stat()
    if (!info.isDirectory() || (expected !== null && !sameIdentity(expected, info))) {
      throw replaced()
    }
    if (checkPath && !(await vouches(fs, fdDir, handle, path, info))) {
      throw replaced()
    }
    return handleAnchor(fs, fdDir, handle, path, info)
  } catch (error) {
    await handle.close()
    throw error
  }
}

function pathAnchor(fs: TransferFs, path: string, info: EntryStat): FolderAnchor {
  const check = async (): Promise<void> => {
    if (!sameIdentity(info, await statOrNull(fs, path))) throw replaced()
  }
  return {
    path,
    stat: info,
    at: async (name) => {
      await check()
      return join(path, name)
    },
    list: async () => {
      await check()
      return fs.readdir(path)
    },
    child: (name, expected) => openPathAnchor(fs, join(path, name), expected),
    stillAt: async () => sameIdentity(info, await statOrNull(fs, path)),
    close: async () => {},
  }
}

async function openPathAnchor(
  fs: TransferFs,
  path: string,
  expected: EntryStat | null,
): Promise<FolderAnchor> {
  const info = await fs.lstat(path)
  if (!info.isDirectory() || (expected !== null && !sameIdentity(expected, info))) {
    throw replaced()
  }
  return pathAnchor(fs, path, info)
}

export function openAnchor(
  fs: TransferFs,
  path: string,
  platform: NodeJS.Platform,
  expected: EntryStat | null = null,
): Promise<FolderAnchor> {
  if (platform === 'linux') return openHandleAnchor(fs, PROC_FD_DIR, path, path, expected, true)
  if (platform === 'darwin') return openHandleAnchor(fs, FD_DIR, path, path, expected, true)
  return openPathAnchor(fs, path, expected)
}
