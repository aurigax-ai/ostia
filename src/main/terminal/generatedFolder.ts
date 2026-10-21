import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

export function hasFiles(dir: string, names: readonly string[]): boolean {
  return names.every((name) => existsSync(join(dir, name)))
}

function stagedFiles(staging: string): string[] {
  return readdirSync(staging, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(staging, join(entry.parentPath, entry.name)))
}

export function installGenerated(
  root: string,
  dir: string,
  names: readonly string[],
  write: (staging: string) => void,
): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (hasFiles(dir, names)) return dir
  const staging = mkdtempSync(join(root, '.staging-'))
  try {
    write(staging)
    for (const name of stagedFiles(staging)) {
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

function removeEmptyFolders(dir: string, stop: string): void {
  let current = dir
  while (current.startsWith(stop)) {
    try {
      rmdirSync(current)
    } catch {
      return
    }
    if (current === stop) return
    current = dirname(current)
  }
}

export function removeGenerated(dir: string, names: readonly string[]): void {
  const folders = new Set<string>()
  for (const name of names) {
    const path = join(dir, name)
    try {
      unlinkSync(path)
    } catch {}
    folders.add(dirname(path))
  }
  const deepestFirst = [...folders].sort((a, b) => b.length - a.length)
  for (const folder of deepestFirst) removeEmptyFolders(folder, dir)
}

const GENERATION_NAME = /^[0-9a-f]{32}$/

function generationFolders(root: string): { dir: string; mtime: number }[] {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    if (!GENERATION_NAME.test(name)) return []
    const dir = join(root, name)
    try {
      const st = lstatSync(dir)
      return st.isDirectory() ? [{ dir, mtime: st.mtimeMs }] : []
    } catch {
      return []
    }
  })
}

export function sweepOldGenerations(
  root: string,
  keep: readonly string[],
  keepNewest: number,
  ownsEntry: (name: string) => boolean,
): string[] {
  const kept = new Set(keep)
  const old = generationFolders(root)
    .filter(({ dir }) => !kept.has(dir))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(keepNewest)
  const removed: string[] = []
  for (const { dir } of old) {
    try {
      const entries = readdirSync(dir)
      if (!entries.every(ownsEntry)) continue
      for (const name of entries) rmSync(join(dir, name), { recursive: true, force: true })
      rmdirSync(dir)
      removed.push(dir)
    } catch {}
  }
  return removed
}
