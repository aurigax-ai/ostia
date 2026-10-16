import { constants } from 'node:fs'
import type { AtFs } from './atTransferFs'
import type { EntryStat } from './transferFs'

const AT_SYMLINK_NOFOLLOW = 0x20
const AT_REMOVEDIR = 0x80
const F_GETPATH = 50
const O_CLOEXEC = 0x1000000
const PATH_MAX = 1024
const LINK_MAX_BYTES = 64 * 1024

const DIRENT_RECLEN = 16
const DIRENT_NAMLEN = 18
const DIRENT_NAME = 21

const STAT_BYTES = 144
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

type Call = (...args: unknown[]) => unknown

interface Binding {
  koffi: typeof import('koffi').default
  calls: Record<string, Call>
}

let loaded: Promise<Binding> | null = null

function binding(): Promise<Binding> {
  loaded ??= load()
  return loaded
}

const load = (): Promise<Binding> =>
  import('koffi').then(({ default: koffi }) => {
    const lib = koffi.load('/usr/lib/libSystem.B.dylib')
    const wide = process.arch === 'x64' ? '$INODE64' : ''
    const declare = (name: string, result: string, params: string[]): Call =>
      lib.func(name, result, params) as Call
    return {
      koffi,
      calls: {
        openat: declare('openat', 'int', ['int', 'str', 'int', '...']),
        fstatat: declare(`fstatat${wide}`, 'int', ['int', 'str', '_Out_ uint8_t *', 'int']),
        mkdirat: declare('mkdirat', 'int', ['int', 'str', 'uint16']),
        symlinkat: declare('symlinkat', 'int', ['str', 'int', 'str']),
        readlinkat: declare('readlinkat', 'long', ['int', 'str', '_Out_ uint8_t *', 'size_t']),
        renameat: declare('renameat', 'int', ['int', 'str', 'int', 'str']),
        unlinkat: declare('unlinkat', 'int', ['int', 'str', 'int']),
        fcntl: declare('fcntl', 'int', ['int', 'int', '...']),
        fdopendir: declare(`fdopendir${wide}`, 'void *', ['int']),
        readdir: declare(`readdir${wide}`, 'void *', ['void *']),
        closedir: declare('closedir', 'int', ['void *']),
        close: declare('close', 'int', ['int']),
      },
    }
  })

function failure(koffi: Binding['koffi'], operation: string): Error {
  const errno = koffi.errno()
  const code = Object.entries(koffi.os.errno).find(([, value]) => value === errno)?.[0] ?? 'EIO'
  return Object.assign(new Error(`${code}: ${operation}`), { code, errno, syscall: operation })
}

async function checked(operation: string, call: (b: Binding) => number): Promise<number> {
  const bound = await binding()
  const result = call(bound)
  if (result < 0) throw failure(bound.koffi, operation)
  return result
}

function entryStat(raw: Buffer): EntryStat {
  const mode = raw.readUInt16LE(4)
  const kind = mode & S_IFMT
  return {
    dev: raw.readInt32LE(0),
    ino: Number(raw.readBigUInt64LE(8)),
    mode,
    uid: raw.readUInt32LE(16),
    isDirectory: () => kind === S_IFDIR,
    isFile: () => kind === S_IFREG,
    isSymbolicLink: () => kind === S_IFLNK,
  }
}

async function readLink(dirFd: number, name: string, size: number): Promise<string> {
  const buffer = Buffer.alloc(size)
  const length = await checked(
    'readlinkat',
    ({ calls }) => calls.readlinkat?.(dirFd, name, buffer, buffer.length) as number,
  )
  if (length < size) return buffer.subarray(0, length).toString('utf8')
  if (size >= LINK_MAX_BYTES) {
    throw Object.assign(new Error('ENAMETOOLONG: readlinkat'), { code: 'ENAMETOOLONG' })
  }
  return readLink(dirFd, name, size * 2)
}

export const macAt: AtFs = {
  openat: (dirFd, name, flags, mode) =>
    checked(
      'openat',
      ({ calls }) => calls.openat?.(dirFd, name, flags | O_CLOEXEC, 'int', mode) as number,
    ),
  lstatat: async (dirFd, name) => {
    const raw = Buffer.alloc(STAT_BYTES)
    await checked(
      'fstatat',
      ({ calls }) => calls.fstatat?.(dirFd, name, raw, AT_SYMLINK_NOFOLLOW) as number,
    )
    return entryStat(raw)
  },
  mkdirat: async (dirFd, name) => {
    await checked('mkdirat', ({ calls }) => calls.mkdirat?.(dirFd, name, 0o777) as number)
  },
  symlinkat: async (target, dirFd, name) => {
    await checked('symlinkat', ({ calls }) => calls.symlinkat?.(target, dirFd, name) as number)
  },
  readlinkat: (dirFd, name) => readLink(dirFd, name, PATH_MAX),
  renameat: async (fromFd, from, toFd, to) => {
    await checked('renameat', ({ calls }) => calls.renameat?.(fromFd, from, toFd, to) as number)
  },
  unlinkat: async (dirFd, name, folder) => {
    await checked(
      'unlinkat',
      ({ calls }) => calls.unlinkat?.(dirFd, name, folder ? AT_REMOVEDIR : 0) as number,
    )
  },
  list: async (dirFd) => {
    const { calls, koffi } = await binding()
    const listing = await macAt.openat(dirFd, '.', constants.O_RDONLY | constants.O_DIRECTORY, 0)
    const dir = calls.fdopendir?.(listing)
    if (dir === null) {
      calls.close?.(listing)
      throw failure(koffi, 'fdopendir')
    }
    try {
      const names: string[] = []
      for (;;) {
        const entry = calls.readdir?.(dir)
        if (entry === null) return names
        const length = koffi.decode(entry, DIRENT_RECLEN, 'uint16') as number
        const raw = Buffer.from(koffi.decode(entry, 0, 'uint8_t', length) as number[])
        const nameLength = raw.readUInt16LE(DIRENT_NAMLEN)
        const name = raw.toString('utf8', DIRENT_NAME, DIRENT_NAME + nameLength)
        if (name !== '.' && name !== '..') names.push(name)
      }
    } finally {
      calls.closedir?.(dir)
    }
  },
  pathOf: async (fd) => {
    const buffer = Buffer.alloc(PATH_MAX)
    await checked(
      'fcntl',
      ({ calls }) => calls.fcntl?.(fd, F_GETPATH, 'uint8_t *', buffer) as number,
    )
    return buffer.subarray(0, buffer.indexOf(0)).toString('utf8')
  },
}
