import { close, constants, fstat, open, type Stats } from 'node:fs'
import type { ArchiveEntryProblem } from '../../../shared/files/filesApi'

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export type EntryRead =
  | { ok: true; data: Buffer }
  | { ok: false; problem: ArchiveEntryProblem | 'too-large' | 'unreadable'; size?: number }

export function closeFd(fd: number): void {
  close(fd, () => {})
}

export interface OpenedFile {
  fd: number
  stat: Stats
}

export function openRegular(path: string): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    open(path, READ_FLAGS, (openError, fd) => {
      if (openError) {
        resolve(null)
        return
      }
      fstat(fd, (statError, stat) => {
        if (!statError && stat.isFile()) {
          resolve({ fd, stat })
          return
        }
        closeFd(fd)
        resolve(null)
      })
    })
  })
}
