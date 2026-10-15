import type { Stats } from 'node:fs'
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
