import { cpSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path'
import type { FileOpResult } from '../../shared/files/fileOps'
import { resolveSafe } from '../platform/pathGuard'

const FILE_OP_MAX_PATHS = 500
const NAME_MAX_BYTES = 255
const COPY_NAME_TRIES = 1000

export interface FileOpsDeps {
  roots: string[]
  trash: (path: string) => Promise<void>
}

type FileOpFailure = Exclude<FileOpResult, { ok: true }>

const fail = (error: FileOpFailure['error']): FileOpFailure => ({
  ok: false,
  error,
})

export function nameProblem(name: unknown): boolean {
  return (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.trim() !== name ||
    Buffer.byteLength(name) > NAME_MAX_BYTES
  )
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function sameEntry(a: string, b: string): boolean {
  const first = lstatSync(a)
  const second = lstatSync(b)
  return first.ino === second.ino && first.dev === second.dev
}

function splitName(name: string): { stem: string; suffix: string } {
  const ext = extname(name)
  return ext && ext !== name
    ? { stem: name.slice(0, -ext.length), suffix: ext }
    : { stem: name, suffix: '' }
}

function everyPath(input: unknown, each: (item: unknown) => string | null): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > FILE_OP_MAX_PATHS) return null
  const out: string[] = []
  for (const item of input) {
    const path = each(item)
    if (path === null) return null
    out.push(path)
  }
  return out
}

export function copyName(dir: string, name: string): string | null {
  const { stem, suffix } = splitName(name)
  for (let i = 1; i <= COPY_NAME_TRIES; i++) {
    const candidate = `${stem} copy${i === 1 ? '' : ` ${i}`}${suffix}`
    if (!exists(join(dir, candidate))) return candidate
  }
  return null
}

export function numberedName(dir: string, name: string): string | null {
  if (!exists(join(dir, name))) return name
  const { stem, suffix } = splitName(name)
  for (let i = 2; i <= COPY_NAME_TRIES; i++) {
    const candidate = `${stem} (${i})${suffix}`
    if (!exists(join(dir, candidate))) return candidate
  }
  return null
}

function isCrossDevice(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EXDEV'
}

export class FileOps {
  private readonly realRoots: string[]

  constructor(private readonly deps: FileOpsDeps) {
    this.realRoots = deps.roots.flatMap((root) => {
      try {
        return [realpathSync(root)]
      } catch {
        return []
      }
    })
  }

  private folder(input: unknown): string | null {
    if (typeof input !== 'string') return null
    const safe = resolveSafe(input, this.deps.roots)
    if (safe === null) return null
    try {
      const real = realpathSync(safe)
      if (!lstatSync(real).isDirectory()) return null
      return this.realRoots.some((root) => isInside(root, real)) ? real : null
    } catch {
      return null
    }
  }

  private entry(input: unknown): string | null {
    if (typeof input !== 'string') return null
    const safe = resolveSafe(input, this.deps.roots)
    if (safe === null || !exists(safe)) return null
    const parent = this.folder(dirname(safe))
    if (parent === null) return null
    const real = join(parent, basename(safe))
    return this.realRoots.includes(real) ? null : real
  }

  private paths(input: unknown): string[] | null {
    return everyPath(input, (item) => this.entry(item))
  }

  create(dirInput: unknown, name: unknown, kind: unknown): FileOpResult {
    const dir = this.folder(dirInput)
    if (dir === null) return fail('outside')
    if (nameProblem(name)) return fail('invalid-name')
    if (kind !== 'file' && kind !== 'folder') return fail('failed')
    const target = join(dir, name as string)
    if (exists(target)) return fail('exists')
    try {
      if (kind === 'folder') mkdirSync(target)
      else writeFileSync(target, '', { flag: 'wx' })
      return { ok: true, paths: [target] }
    } catch {
      return fail('failed')
    }
  }

  rename(pathInput: unknown, name: unknown): FileOpResult {
    const source = this.entry(pathInput)
    if (source === null) return fail('outside')
    if (nameProblem(name)) return fail('invalid-name')
    const target = join(dirname(source), name as string)
    if (target === source) return { ok: true, paths: [source] }
    if (exists(target) && !sameEntry(source, target)) return fail('exists')
    try {
      renameSync(source, target)
      return { ok: true, paths: [target] }
    } catch {
      return fail('failed')
    }
  }

  private plan(
    sources: string[] | null,
    destInput: unknown,
  ): { sources: string[]; dest: string } | FileOpFailure {
    const dest = this.folder(destInput)
    if (sources === null || dest === null) return fail('outside')
    if (sources.some((source) => isInside(source, dest))) {
      return fail('into-itself')
    }
    return { sources, dest }
  }

  move(pathsInput: unknown, destInput: unknown): FileOpResult {
    const planned = this.plan(this.paths(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    const moves = sources
      .filter((source) => dirname(source) !== dest)
      .map((source) => ({ source, target: join(dest, basename(source)) }))
    if (moves.some(({ target }) => exists(target))) return fail('exists')
    const done: string[] = []
    for (const { source, target } of moves) {
      try {
        renameSync(source, target)
        done.push(target)
      } catch {
        return { ok: false, error: 'failed', paths: done }
      }
    }
    return { ok: true, paths: done }
  }

  copy(pathsInput: unknown, destInput: unknown): FileOpResult {
    const planned = this.plan(this.paths(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    const done: string[] = []
    for (const source of sources) {
      const name = basename(source)
      const free = exists(join(dest, name)) ? copyName(dest, name) : name
      if (free === null) return { ok: false, error: 'exists', paths: done }
      const target = join(dest, free)
      try {
        this.copyEntry(source, target)
        done.push(target)
      } catch {
        return { ok: false, error: 'failed', paths: done }
      }
    }
    return { ok: true, paths: done }
  }

  private dropped(input: unknown): string[] | null {
    return everyPath(input, (item) => {
      if (typeof item !== 'string' || !isAbsolute(item) || !exists(item)) return null
      const real = join(realpathSync(dirname(item)), basename(item))
      return this.realRoots.includes(real) ? null : real
    })
  }

  private copyEntry(source: string, target: string): void {
    cpSync(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    })
  }

  private async moveEntry(source: string, target: string): Promise<void> {
    try {
      renameSync(source, target)
    } catch (error) {
      if (!isCrossDevice(error)) throw error
      this.copyEntry(source, target)
      await this.deps.trash(source)
    }
  }

  async importInto(pathsInput: unknown, destInput: unknown, move: boolean): Promise<FileOpResult> {
    const planned = this.plan(this.dropped(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    const done: string[] = []
    for (const source of sources) {
      if (move && dirname(source) === dest) {
        done.push(source)
        continue
      }
      const free = numberedName(dest, basename(source))
      if (free === null) return { ok: false, error: 'exists', paths: done }
      const target = join(dest, free)
      try {
        if (move) await this.moveEntry(source, target)
        else this.copyEntry(source, target)
        done.push(target)
      } catch {
        return { ok: false, error: 'failed', paths: done }
      }
    }
    return { ok: true, paths: done }
  }

  draggable(input: unknown): string | null {
    const path = this.entry(input)
    if (path === null) return null
    const stat = lstatSync(path)
    return stat.isFile() || stat.isDirectory() ? path : null
  }

  async trash(pathsInput: unknown): Promise<FileOpResult> {
    const sources = this.paths(pathsInput)
    if (sources === null) return fail('outside')
    const done: string[] = []
    for (const source of sources) {
      try {
        await this.deps.trash(source)
        done.push(source)
      } catch {
        return { ok: false, error: 'failed', paths: done }
      }
    }
    return { ok: true, paths: done }
  }
}
