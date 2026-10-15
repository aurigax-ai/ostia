import { constants, type Stats } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { TransferEnd } from './exclusiveTransfer'
import { type FolderAnchor, openAnchor } from './folderAnchor'
import type { TransferFs } from './transferFs'

const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const PRIVATE_MODE = 0o700
const STICKY_BIT = 0o1000
const NAME_TRIES = 1000
const UNRESERVED = /[A-Za-z0-9\-._~/]/

export interface TrashPlace {
  root: string
  topdir: string | null
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function sameEntry(a: Stats, b: Stats | null): boolean {
  return b !== null && a.dev === b.dev && a.ino === b.ino
}

export function encodeTrashPath(path: string): string {
  let out = ''
  for (const byte of Buffer.from(path)) {
    const char = String.fromCharCode(byte)
    out +=
      byte < 0x80 && UNRESERVED.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

function localDate(at: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}

export function trashInfo(original: string, place: TrashPlace, at: Date): string {
  const path = place.topdir === null ? original : relative(place.topdir, original)
  return `[Trash Info]\nPath=${encodeTrashPath(path)}\nDeletionDate=${localDate(at)}\n`
}

async function makePrivateFolder(path: string): Promise<void> {
  await mkdir(path, { mode: PRIVATE_MODE }).catch((error) => {
    if (errorCode(error) !== 'EEXIST') throw error
  })
}

async function ownFolder(path: string, uid: number, dev: number): Promise<boolean> {
  const info = await lstat(path).catch(() => null)
  return info?.isDirectory() === true && info.uid === uid && info.dev === dev
}

async function readyTrashRoot(root: string, uid: number, dev: number): Promise<boolean> {
  await makePrivateFolder(root).catch(() => {})
  if (!(await ownFolder(root, uid, dev))) return false
  await makePrivateFolder(join(root, 'files'))
  await makePrivateFolder(join(root, 'info'))
  return true
}

export async function homeTrashPlace(home: string, itemDev: number): Promise<TrashPlace | null> {
  await mkdir(join(home, 'files'), { recursive: true, mode: PRIVATE_MODE })
  await mkdir(join(home, 'info'), { recursive: true, mode: PRIVATE_MODE })
  return (await lstat(home)).dev === itemDev ? { root: home, topdir: null } : null
}

export async function topdirTrashPlace(
  topdir: string,
  uid: number,
  itemDev: number,
): Promise<TrashPlace> {
  const shared = join(topdir, '.Trash')
  const info = await lstat(shared).catch(() => null)
  const sticky = info?.isDirectory() === true && (info.mode & STICKY_BIT) !== 0
  if (sticky && (await readyTrashRoot(join(shared, String(uid)), uid, itemDev))) {
    return { root: join(shared, String(uid)), topdir }
  }
  const own = join(topdir, `.Trash-${uid}`)
  if (await readyTrashRoot(own, uid, itemDev)) return { root: own, topdir }
  throw new Error('no-trash')
}

export async function mountTopdir(path: string): Promise<string> {
  const dev = (await lstat(path)).dev
  let current = path
  for (;;) {
    const parent = dirname(current)
    if (parent === current || (await lstat(parent)).dev !== dev) return current
    current = parent
  }
}

async function removeOwn(fs: TransferFs, anchor: FolderAnchor, name: string, own: Stats) {
  const path = await anchor.at(name)
  if (!sameEntry(own, await fs.lstat(path).catch(() => null))) return
  await (own.isDirectory() ? fs.rmdir(path) : fs.unlink(path)).catch(() => {})
}

async function claimInfo(
  fs: TransferFs,
  info: FolderAnchor,
  name: string,
  text: string,
): Promise<Stats | null> {
  const handle = await fs
    .open(await info.at(`${name}.trashinfo`), CREATE_FLAGS, 0o600)
    .catch((error) => {
      if (errorCode(error) === 'EEXIST') return null
      throw error
    })
  if (handle === null) return null
  try {
    await handle.writeFile(text)
    return await handle.stat()
  } finally {
    await handle.close()
  }
}

async function claimPlaceholder(
  fs: TransferFs,
  files: FolderAnchor,
  name: string,
  folder: boolean,
): Promise<Stats | null> {
  const path = await files.at(name)
  try {
    if (folder) {
      await fs.mkdir(path)
      return await fs.lstat(path)
    }
    const handle = await fs.open(path, CREATE_FLAGS, 0o600)
    try {
      return await handle.stat()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null
    throw error
  }
}

function trashedName(name: string, attempt: number): string {
  return attempt === 1 ? name : `${name}.${attempt}`
}

async function trashInto(
  fs: TransferFs,
  source: TransferEnd,
  expected: Stats,
  files: FolderAnchor,
  info: FolderAnchor,
  text: string,
): Promise<boolean> {
  if (files.stat.dev !== expected.dev) return false
  for (let attempt = 1; attempt <= NAME_TRIES; attempt++) {
    const name = trashedName(source.name, attempt)
    const infoStat = await claimInfo(fs, info, name, text)
    if (infoStat === null) continue
    const placeholder = await claimPlaceholder(fs, files, name, expected.isDirectory())
    if (placeholder === null) {
      await removeOwn(fs, info, `${name}.trashinfo`, infoStat)
      continue
    }
    const now = await fs.lstat(await source.anchor.at(source.name)).catch(() => null)
    try {
      if (!sameEntry(expected, now)) throw new Error('source-replaced')
      await fs.rename(await source.anchor.at(source.name), await files.at(name))
    } catch {
      await removeOwn(fs, files, name, placeholder)
      await removeOwn(fs, info, `${name}.trashinfo`, infoStat)
      return false
    }
    return sameEntry(expected, await fs.lstat(await files.at(name)).catch(() => null))
  }
  return false
}

export async function moveToTrash(
  fs: TransferFs,
  source: TransferEnd,
  expected: Stats,
  place: TrashPlace,
  at: Date,
): Promise<boolean> {
  const text = trashInfo(join(source.anchor.path, source.name), place, at)
  const files = await openAnchor(fs, join(place.root, 'files'), 'linux')
  try {
    const info = await openAnchor(fs, join(place.root, 'info'), 'linux')
    try {
      return await trashInto(fs, source, expected, files, info, text)
    } finally {
      await info.close().catch(() => {})
    }
  } finally {
    await files.close().catch(() => {})
  }
}
