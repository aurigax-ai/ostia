import { cpSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, sep } from 'node:path'
import type { FileOpResult } from '../shared/fileOps'
import { resolveSafe } from './pathGuard'

export const FILE_OP_MAX_PATHS = 500
const NAME_MAX_BYTES = 255
const COPY_NAME_TRIES = 1000

export interface FileOpsDeps {
  roots: string[]
  trash: (path: string) => Promise<void>
}

const fail = (error: Exclude<FileOpResult, { ok: true }>['error']): FileOpResult => ({
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

export function copyName(dir: string, name: string): string | null {
  const ext = extname(name)
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name
  const suffix = ext && ext !== name ? ext : ''
  for (let i = 1; i <= COPY_NAME_TRIES; i++) {
    const candidate = `${stem} copy${i === 1 ? '' : ` ${i}`}${suffix}`
    if (!exists(join(dir, candidate))) return candidate
  }
  return null
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
    if (!Array.isArray(input) || input.length === 0 || input.length > FILE_OP_MAX_PATHS) {
      return null
    }
    const out: string[] = []
    for (const item of input) {
      const path = this.entry(item)
      if (path === null) return null
      out.push(path)
    }
    return out
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

  move(pathsInput: unknown, destInput: unknown): FileOpResult {
    const sources = this.paths(pathsInput)
    const dest = this.folder(destInput)
    if (sources === null || dest === null) return fail('outside')
    if (sources.some((source) => isInside(source, dest))) return fail('into-itself')
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
    const sources = this.paths(pathsInput)
    const dest = this.folder(destInput)
    if (sources === null || dest === null) return fail('outside')
    if (sources.some((source) => isInside(source, dest))) return fail('into-itself')
    const done: string[] = []
    for (const source of sources) {
      const name = basename(source)
      const free = exists(join(dest, name)) ? copyName(dest, name) : name
      if (free === null) return { ok: false, error: 'exists', paths: done }
      const target = join(dest, free)
      try {
        cpSync(source, target, {
          recursive: true,
          errorOnExist: true,
          force: false,
          verbatimSymlinks: true,
        })
        done.push(target)
      } catch {
        return { ok: false, error: 'failed', paths: done }
      }
    }
    return { ok: true, paths: done }
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
