import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { expectErrno } from '../diagnostics/errorReport'
import { isInsidePath } from '../platform/pathGuard'

export const GENERATED_LIST = '.ostia-files'

const LIST_MAX_BYTES = 1024 * 1024

export function hasFiles(dir: string, names: readonly string[]): boolean {
  return names.every((name) => existsSync(join(dir, name)))
}

function stagedFiles(staging: string): string[] {
  return readdirSync(staging, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(staging, join(entry.parentPath, entry.name)))
}

function writeList(staging: string, names: readonly string[]): void {
  const listed = [...new Set(names)].filter((name) => name !== GENERATED_LIST)
  writeFileSync(join(staging, GENERATED_LIST), JSON.stringify(listed), { mode: 0o600 })
}

function recordList(root: string, dir: string, names: readonly string[]): void {
  if (existsSync(join(dir, GENERATED_LIST))) return
  let staging: string | null = null
  try {
    staging = mkdtempSync(join(root, '.staging-'))
    writeList(staging, names)
    renameSync(join(staging, GENERATED_LIST), join(dir, GENERATED_LIST))
  } catch (err) {
    expectErrno(err)
  } finally {
    if (staging !== null) rmSync(staging, { recursive: true, force: true })
  }
}

export function installGenerated(
  root: string,
  dir: string,
  names: readonly string[],
  write: (staging: string) => void,
): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (hasFiles(dir, names)) {
    recordList(root, dir, names)
    return dir
  }
  const staging = mkdtempSync(join(root, '.staging-'))
  try {
    write(staging)
    const written = stagedFiles(staging)
    writeList(staging, [...names, ...written])
    for (const name of [...written, GENERATED_LIST]) {
      const target = join(dir, name)
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      renameSync(join(staging, name), target)
    }
  } catch (err) {
    if (!hasFiles(dir, names)) throw err
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return dir
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch (err) {
    expectErrno(err)
    return false
  }
}

function ownedFile(dir: string, name: string): string | null {
  if (isAbsolute(name)) return null
  const parts = name.split(/[\\/]/)
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  let folder = dir
  for (const part of parts.slice(0, -1)) {
    folder = join(folder, part)
    if (!isRealDir(folder)) return null
  }
  const file = join(folder, parts[parts.length - 1])
  try {
    return lstatSync(file).isFile() ? file : null
  } catch (err) {
    expectErrno(err)
    return null
  }
}

function removeEmptyFolders(dir: string, stop: string): void {
  let current = dir
  while (isInsidePath(stop, current)) {
    try {
      rmdirSync(current)
    } catch (err) {
      expectErrno(err)
      return
    }
    if (current === stop) return
    current = dirname(current)
  }
}

export function removeGenerated(dir: string, names: readonly string[]): void {
  if (!isRealDir(dir)) return
  const folders = new Set<string>([dir])
  for (const name of [...names, GENERATED_LIST]) {
    const file = ownedFile(dir, name)
    if (file === null) continue
    try {
      unlinkSync(file)
    } catch (err) {
      expectErrno(err)
    }
    folders.add(dirname(file))
  }
  const deepestFirst = [...folders].sort((a, b) => b.length - a.length)
  for (const folder of deepestFirst) removeEmptyFolders(folder, dir)
}

function readList(dir: string): string[] | null {
  const file = join(dir, GENERATED_LIST)
  try {
    const st = lstatSync(file)
    if (!st.isFile() || st.size > LIST_MAX_BYTES) return null
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === 'string')) return null
    return parsed
  } catch (err) {
    if (!(err instanceof SyntaxError)) expectErrno(err)
    return null
  }
}

export function touchGenerated(dir: string, now: Date = new Date()): void {
  try {
    if (isRealDir(dir)) utimesSync(dir, now, now)
  } catch (err) {
    expectErrno(err)
  }
}

export function removeUntouchedGenerations(
  root: string,
  keep: ReadonlySet<string>,
  untouchedSince: number,
): string[] {
  if (!isRealDir(root)) return []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (err) {
    expectErrno(err)
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const dir = join(root, entry)
    if (keep.has(dir)) continue
    let modified: number
    try {
      const st = lstatSync(dir)
      if (!st.isDirectory()) continue
      modified = st.mtimeMs
    } catch (err) {
      expectErrno(err)
      continue
    }
    if (modified >= untouchedSince) continue
    const names = readList(dir)
    if (names === null) continue
    removeGenerated(dir, names)
    removed.push(dir)
  }
  return removed
}
