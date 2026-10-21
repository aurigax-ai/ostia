import { close, fstat, read, write, writeFile } from 'node:fs'
import { promisify } from 'node:util'
import { type EntryStat, nodeTransferFs, type OpenFile, type TransferFs } from './transferFs'

export const FD_DIR = '/dev/fd'

export interface AtFs {
  openat: (dirFd: number, name: string, flags: number, mode: number) => Promise<number>
  lstatat: (dirFd: number, name: string) => Promise<EntryStat>
  mkdirat: (dirFd: number, name: string) => Promise<void>
  symlinkat: (target: string, dirFd: number, name: string) => Promise<void>
  readlinkat: (dirFd: number, name: string) => Promise<string>
  renameat: (fromFd: number, from: string, toFd: number, to: string) => Promise<void>
  unlinkat: (dirFd: number, name: string, folder: boolean) => Promise<void>
  list: (dirFd: number) => Promise<string[]>
  pathOf: (fd: number) => Promise<string>
}

interface FdEntry {
  fd: number
  name: string | null
}

const readAt = promisify(read)
const writeAt = promisify(write)
const closeFd = promisify(close)
const statFd = promisify(fstat)
const writeWhole = promisify(writeFile)

function parse(path: string): FdEntry | null {
  if (!path.startsWith(`${FD_DIR}/`)) return null
  const [fd, name, ...rest] = path.slice(FD_DIR.length + 1).split('/')
  if (rest.length > 0 || !/^\d+$/.test(fd ?? '')) return null
  return { fd: Number(fd), name: name ?? null }
}

function named(path: string): { fd: number; name: string } | null {
  const entry = parse(path)
  return entry !== null && entry.name !== null ? { fd: entry.fd, name: entry.name } : null
}

function openFile(fd: number): OpenFile {
  return {
    fd,
    stat: (() => statFd(fd)) as OpenFile['stat'],
    read: ((buffer: Buffer, offset: number, length: number, position: number | null) =>
      readAt(fd, buffer, offset, length, position)) as OpenFile['read'],
    write: ((buffer: Buffer, offset: number, length: number) =>
      writeAt(fd, buffer, offset, length)) as OpenFile['write'],
    writeFile: ((data: string) => writeWhole(fd, data)) as OpenFile['writeFile'],
    close: () => closeFd(fd),
  }
}

export function atTransferFs(at: AtFs): TransferFs {
  return {
    lstat: (path) => {
      const entry = named(path)
      return entry === null ? nodeTransferFs.lstat(path) : at.lstatat(entry.fd, entry.name)
    },
    readdir: (path) => {
      const entry = parse(path)
      return entry === null ? nodeTransferFs.readdir(path) : at.list(entry.fd)
    },
    readlink: (path) => {
      const entry = parse(path)
      if (entry === null) return nodeTransferFs.readlink(path)
      return entry.name === null ? at.pathOf(entry.fd) : at.readlinkat(entry.fd, entry.name)
    },
    mkdir: (path) => {
      const entry = named(path)
      return entry === null ? nodeTransferFs.mkdir(path) : at.mkdirat(entry.fd, entry.name)
    },
    symlink: (target, path) => {
      const entry = named(path)
      return entry === null
        ? nodeTransferFs.symlink(target, path)
        : at.symlinkat(target, entry.fd, entry.name)
    },
    open: async (path, flags, mode) => {
      const entry = named(path)
      if (entry === null) return nodeTransferFs.open(path, flags, mode)
      return openFile(await at.openat(entry.fd, entry.name, flags, mode ?? 0o666))
    },
    rename: (from, to) => {
      const source = named(from)
      const target = named(to)
      if (source === null || target === null) return nodeTransferFs.rename(from, to)
      return at.renameat(source.fd, source.name, target.fd, target.name)
    },
    rmdir: (path) => {
      const entry = named(path)
      return entry === null ? nodeTransferFs.rmdir(path) : at.unlinkat(entry.fd, entry.name, true)
    },
    unlink: (path) => {
      const entry = named(path)
      return entry === null ? nodeTransferFs.unlink(path) : at.unlinkat(entry.fd, entry.name, false)
    },
  }
}
