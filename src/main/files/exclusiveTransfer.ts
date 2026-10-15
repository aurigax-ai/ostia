import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

const CP_OPTIONS = {
  recursive: true,
  errorOnExist: true,
  force: false,
  verbatimSymlinks: true,
} as const

const NO_LINK_CODES = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'])

export type CopyClaim = 'done' | 'taken'

export type MoveClaim = CopyClaim | 'copy'

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
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

async function filled(
  target: string,
  discard: (path: string) => Promise<void>,
  fill: () => Promise<unknown>,
): Promise<CopyClaim> {
  try {
    await fill()
    return 'done'
  } catch (error) {
    await discard(target).catch(() => {})
    throw error
  }
}

async function copyLink(source: string, target: string): Promise<boolean> {
  const destination = await readlink(source)
  return claimed(() => symlink(destination, target))
}

export async function copyExclusive(
  source: string,
  target: string,
  discard: (path: string) => Promise<void>,
): Promise<CopyClaim> {
  const stat = await lstat(source)
  if (stat.isSymbolicLink()) return (await copyLink(source, target)) ? 'done' : 'taken'
  if (stat.isDirectory()) {
    if (!(await claimed(() => mkdir(target)))) return 'taken'
    return filled(target, discard, async () => {
      for (const name of await readdir(source)) {
        await cp(join(source, name), join(target, name), CP_OPTIONS)
      }
    })
  }
  if (!(await claimed(() => writeFile(target, '', { flag: 'wx' })))) return 'taken'
  return filled(target, discard, () => copyFile(source, target))
}

async function moveFolder(source: string, target: string): Promise<MoveClaim> {
  if (!(await claimed(() => mkdir(target)))) return 'taken'
  try {
    await rename(source, target)
    return 'done'
  } catch (error) {
    await rmdir(target).catch(() => {})
    if (errorCode(error) === 'EXDEV') return 'copy'
    throw error
  }
}

export async function moveExclusive(source: string, target: string): Promise<MoveClaim> {
  const stat = await lstat(source)
  if (stat.isDirectory()) return moveFolder(source, target)
  try {
    const made = stat.isSymbolicLink()
      ? await copyLink(source, target)
      : await claimed(() => link(source, target))
    if (!made) return 'taken'
  } catch (error) {
    if (NO_LINK_CODES.has(errorCode(error) ?? '')) return 'copy'
    throw error
  }
  try {
    await unlink(source)
    return 'done'
  } catch (error) {
    await unlink(target).catch(() => {})
    throw error
  }
}
