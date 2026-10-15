import { constants, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { TransferFs } from './transferFs'

const ANCHOR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

export interface FolderAnchor {
  readonly path: string
  readonly stat: Stats
  at: (name: string) => Promise<string>
  list: () => Promise<string[]>
  child: (name: string, expected: Stats) => Promise<FolderAnchor>
  stillAt: () => Promise<boolean>
  close: () => Promise<void>
}

function sameIdentity(a: Stats, b: Stats | null): boolean {
  return b?.isDirectory() === true && a.dev === b.dev && a.ino === b.ino
}

function replaced(): Error {
  return new Error('folder-replaced')
}

async function statOrNull(fs: TransferFs, path: string): Promise<Stats | null> {
  return fs.lstat(path).catch(() => null)
}

function handleAnchor(fs: TransferFs, handle: FileHandle, path: string, info: Stats): FolderAnchor {
  const base = `/proc/self/fd/${handle.fd}`
  return {
    path,
    stat: info,
    at: async (name) => `${base}/${name}`,
    list: () => fs.readdir(base),
    child: (name, expected) =>
      openHandleAnchor(fs, `${base}/${name}`, join(path, name), expected, false),
    stillAt: async () => sameIdentity(info, await statOrNull(fs, path)),
    close: () => handle.close(),
  }
}

async function openHandleAnchor(
  fs: TransferFs,
  openPath: string,
  path: string,
  expected: Stats | null,
  checkPath: boolean,
): Promise<FolderAnchor> {
  const handle = await fs.open(openPath, ANCHOR_FLAGS)
  try {
    const info = await handle.stat()
    if (!info.isDirectory() || (expected !== null && !sameIdentity(expected, info))) {
      throw replaced()
    }
    if (checkPath && (await fs.readlink(`/proc/self/fd/${handle.fd}`)) !== path) {
      throw replaced()
    }
    return handleAnchor(fs, handle, path, info)
  } catch (error) {
    await handle.close()
    throw error
  }
}

function pathAnchor(fs: TransferFs, path: string, info: Stats): FolderAnchor {
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
  expected: Stats | null,
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
  expected: Stats | null = null,
): Promise<FolderAnchor> {
  return platform === 'linux'
    ? openHandleAnchor(fs, path, path, expected, true)
    : openPathAnchor(fs, path, expected)
}
