import {
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import type { AtFs } from './atTransferFs'

const at = (fd: number, name: string): string => `/proc/self/fd/${fd}/${name}`

export const procAtFs: AtFs = {
  openat: async (dirFd, name, flags, mode) => openSync(at(dirFd, name), flags, mode),
  lstatat: async (dirFd, name) => lstatSync(at(dirFd, name)),
  mkdirat: async (dirFd, name) => {
    mkdirSync(at(dirFd, name))
  },
  symlinkat: async (target, dirFd, name) => symlinkSync(target, at(dirFd, name)),
  readlinkat: async (dirFd, name) => readlinkSync(at(dirFd, name)),
  renameat: async (fromFd, from, toFd, to) => renameSync(at(fromFd, from), at(toFd, to)),
  unlinkat: async (dirFd, name, folder) =>
    folder ? rmdirSync(at(dirFd, name)) : unlinkSync(at(dirFd, name)),
  list: async (dirFd) => readdirSync(`/proc/self/fd/${dirFd}`),
  pathOf: async (fd) => readlinkSync(`/proc/self/fd/${fd}`),
}
