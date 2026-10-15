import { lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path'
import type { FileOpResult } from '../../shared/files/fileOps'
import { resolveSafe } from '../platform/pathGuard'
import { copyExclusive, moveExclusive } from './exclusiveTransfer'

const FILE_OP_MAX_PATHS = 500
const NAME_MAX_BYTES = 255
const COPY_NAME_TRIES = 1000
const CLAIM_TRIES = 20

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

type PickName = (dir: string, name: string) => string | null

const sameName: PickName = (dir, name) => (exists(join(dir, name)) ? null : name)

const copyOrSameName: PickName = (dir, name) =>
  exists(join(dir, name)) ? copyName(dir, name) : name

function isDroppable(path: string): boolean {
  const stat = lstatSync(path)
  return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()
}

type Transfer = { ok: true; target: string } | FileOpFailure

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

  private async firstFreeName(
    source: string,
    dest: string,
    pick: PickName,
    attempt: (target: string) => Promise<Transfer | 'taken'>,
  ): Promise<Transfer> {
    for (let tries = 0; tries < CLAIM_TRIES; tries++) {
      const name = pick(dest, basename(source))
      if (name === null) return fail('exists')
      const sent = await attempt(join(dest, name))
      if (sent !== 'taken') return sent
    }
    return fail('exists')
  }

  private copyNew(source: string, dest: string, pick: PickName): Promise<Transfer> {
    return this.firstFreeName(source, dest, pick, async (target) =>
      (await copyExclusive(source, target, this.deps.trash)) === 'done'
        ? { ok: true, target }
        : 'taken',
    )
  }

  private moveNew(source: string, dest: string, pick: PickName): Promise<Transfer> {
    return this.firstFreeName(source, dest, pick, async (target) => {
      const moved = await moveExclusive(source, target)
      if (moved === 'copy') return this.copyThenTrash(source, dest, pick)
      return moved === 'done' ? { ok: true, target } : 'taken'
    })
  }

  private async copyThenTrash(source: string, dest: string, pick: PickName): Promise<Transfer> {
    const copied = await this.copyNew(source, dest, pick)
    if (!copied.ok) return copied
    try {
      await this.deps.trash(source)
      return copied
    } catch {
      return { ok: false, error: 'not-moved', paths: [copied.target] }
    }
  }

  private async transferAll(
    sources: string[],
    send: (source: string) => Promise<Transfer>,
  ): Promise<FileOpResult> {
    const done: string[] = []
    for (const source of sources) {
      try {
        const sent = await send(source)
        if (!sent.ok)
          return { ok: false, error: sent.error, paths: [...done, ...(sent.paths ?? [])] }
        done.push(sent.target)
      } catch {
        return { ok: false, error: 'failed', paths: done }
      }
    }
    return { ok: true, paths: done }
  }

  async move(pathsInput: unknown, destInput: unknown): Promise<FileOpResult> {
    const planned = this.plan(this.paths(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    const moving = sources.filter((source) => dirname(source) !== dest)
    if (moving.some((source) => exists(join(dest, basename(source))))) return fail('exists')
    return this.transferAll(moving, (source) => this.moveNew(source, dest, sameName))
  }

  async copy(pathsInput: unknown, destInput: unknown): Promise<FileOpResult> {
    const planned = this.plan(this.paths(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    return this.transferAll(sources, (source) => this.copyNew(source, dest, copyOrSameName))
  }

  private dropped(input: unknown): string[] | null {
    return everyPath(input, (item) => {
      if (typeof item !== 'string' || !isAbsolute(item) || !exists(item)) return null
      const real = join(realpathSync(dirname(item)), basename(item))
      if (this.realRoots.includes(real) || !isDroppable(real)) return null
      return real
    })
  }

  async importInto(pathsInput: unknown, destInput: unknown, move: boolean): Promise<FileOpResult> {
    const planned = this.plan(this.dropped(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    return this.transferAll(sources, async (source) => {
      if (!move) return this.copyNew(source, dest, numberedName)
      if (dirname(source) === dest) return { ok: true, target: source }
      return this.moveNew(source, dest, numberedName)
    })
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
