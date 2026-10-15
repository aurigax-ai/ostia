import type { Stats } from 'node:fs'
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path'
import type { FileOpResult } from '../../shared/files/fileOps'
import { resolveSafe } from '../platform/pathGuard'
import { type TransferFs, copyExclusive, moveExclusive } from './exclusiveTransfer'

const FILE_OP_MAX_PATHS = 500
const NAME_MAX_BYTES = 255
const COPY_NAME_TRIES = 1000
const CLAIM_TRIES = 20

export interface FileOpsDeps {
  roots: string[]
  trash: (path: string) => Promise<void>
  fs?: TransferFs
  platform?: NodeJS.Platform
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

async function stat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path)) !== null
}

async function sameEntry(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([stat(a), stat(b)])
  return first !== null && second !== null && first.ino === second.ino && first.dev === second.dev
}

function splitName(name: string): { stem: string; suffix: string } {
  const ext = extname(name)
  return ext && ext !== name
    ? { stem: name.slice(0, -ext.length), suffix: ext }
    : { stem: name, suffix: '' }
}

async function everyPath(
  input: unknown,
  each: (item: unknown) => Promise<string | null>,
): Promise<string[] | null> {
  if (!Array.isArray(input) || input.length === 0 || input.length > FILE_OP_MAX_PATHS) return null
  const out: string[] = []
  for (const item of input) {
    const path = await each(item)
    if (path === null) return null
    out.push(path)
  }
  return out
}

async function firstAbsent(dir: string, names: Iterable<string>): Promise<string | null> {
  for (const name of names) {
    if (!(await exists(join(dir, name)))) return name
  }
  return null
}

function* copyNames(name: string): Generator<string> {
  const { stem, suffix } = splitName(name)
  for (let i = 1; i <= COPY_NAME_TRIES; i++) yield `${stem} copy${i === 1 ? '' : ` ${i}`}${suffix}`
}

function* numberedNames(name: string): Generator<string> {
  yield name
  const { stem, suffix } = splitName(name)
  for (let i = 2; i <= COPY_NAME_TRIES; i++) yield `${stem} (${i})${suffix}`
}

export function copyName(dir: string, name: string): Promise<string | null> {
  return firstAbsent(dir, copyNames(name))
}

export function numberedName(dir: string, name: string): Promise<string | null> {
  return firstAbsent(dir, numberedNames(name))
}

type PickName = (dir: string, name: string) => Promise<string | null>

const sameName: PickName = (dir, name) => firstAbsent(dir, [name])

const copyOrSameName: PickName = async (dir, name) =>
  (await exists(join(dir, name))) ? copyName(dir, name) : name

async function isDroppable(path: string): Promise<boolean> {
  const info = await stat(path)
  return info !== null && (info.isFile() || info.isDirectory() || info.isSymbolicLink())
}

type Transfer = { ok: true; target: string } | FileOpFailure

interface Destination {
  path: string
  stat: Stats
}

export class FileOps {
  private readonly realRoots: Promise<string[]>

  constructor(private readonly deps: FileOpsDeps) {
    this.realRoots = Promise.all(
      deps.roots.map((root) =>
        realpath(root).then(
          (real) => [real],
          () => [],
        ),
      ),
    ).then((reals) => reals.flat())
  }

  private transferOptions(parent: Stats) {
    return { parent, fs: this.deps.fs, platform: this.deps.platform }
  }

  private async destination(input: unknown): Promise<Destination | null> {
    if (typeof input !== 'string') return null
    const safe = resolveSafe(input, this.deps.roots)
    if (safe === null) return null
    try {
      const real = await realpath(safe)
      const info = await lstat(real)
      if (!info.isDirectory()) return null
      const roots = await this.realRoots
      return roots.some((root) => isInside(root, real)) ? { path: real, stat: info } : null
    } catch {
      return null
    }
  }

  private async entry(input: unknown): Promise<string | null> {
    if (typeof input !== 'string') return null
    const safe = resolveSafe(input, this.deps.roots)
    if (safe === null || !(await exists(safe))) return null
    const parent = await this.destination(dirname(safe))
    if (parent === null) return null
    const real = join(parent.path, basename(safe))
    return (await this.realRoots).includes(real) ? null : real
  }

  private paths(input: unknown): Promise<string[] | null> {
    return everyPath(input, (item) => this.entry(item))
  }

  async create(dirInput: unknown, name: unknown, kind: unknown): Promise<FileOpResult> {
    const dir = await this.destination(dirInput)
    if (dir === null) return fail('outside')
    if (nameProblem(name)) return fail('invalid-name')
    if (kind !== 'file' && kind !== 'folder') return fail('failed')
    const target = join(dir.path, name as string)
    try {
      if (kind === 'folder') await mkdir(target)
      else await writeFile(target, '', { flag: 'wx' })
      return { ok: true, paths: [target] }
    } catch (error) {
      return fail((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed')
    }
  }

  async rename(pathInput: unknown, name: unknown): Promise<FileOpResult> {
    const source = await this.entry(pathInput)
    if (source === null) return fail('outside')
    if (nameProblem(name)) return fail('invalid-name')
    const target = join(dirname(source), name as string)
    if (target === source) return { ok: true, paths: [source] }
    const parent = await this.destination(dirname(source))
    if (parent === null) return fail('outside')
    try {
      const moved = (await sameEntry(source, target))
        ? await rename(source, target).then(() => 'done' as const)
        : await moveExclusive(source, target, this.transferOptions(parent.stat))
      if (moved === 'taken') return fail('exists')
      if (moved === 'copy') {
        if (await exists(target)) return fail('exists')
        await rename(source, target)
      }
      return { ok: true, paths: [target] }
    } catch {
      return fail('failed')
    }
  }

  private async plan(
    sources: string[] | null,
    destInput: unknown,
  ): Promise<{ sources: string[]; dest: Destination } | FileOpFailure> {
    const dest = await this.destination(destInput)
    if (sources === null || dest === null) return fail('outside')
    if (sources.some((source) => isInside(source, dest.path))) return fail('into-itself')
    return { sources, dest }
  }

  private async firstFreeName(
    source: string,
    dest: Destination,
    pick: PickName,
    attempt: (target: string) => Promise<Transfer | 'taken'>,
  ): Promise<Transfer> {
    for (let tries = 0; tries < CLAIM_TRIES; tries++) {
      const name = await pick(dest.path, basename(source))
      if (name === null) return fail('exists')
      const sent = await attempt(join(dest.path, name))
      if (sent !== 'taken') return sent
    }
    return fail('exists')
  }

  private copyNew(source: string, dest: Destination, pick: PickName): Promise<Transfer> {
    return this.firstFreeName(source, dest, pick, async (target) =>
      (await copyExclusive(source, target, this.deps.trash, this.transferOptions(dest.stat))) ===
      'done'
        ? { ok: true, target }
        : 'taken',
    )
  }

  private moveNew(source: string, dest: Destination, pick: PickName): Promise<Transfer> {
    return this.firstFreeName(source, dest, pick, async (target) => {
      const moved = await moveExclusive(source, target, this.transferOptions(dest.stat))
      if (moved === 'copy') return this.copyThenTrash(source, dest, pick)
      return moved === 'done' ? { ok: true, target } : 'taken'
    })
  }

  private async copyThenTrash(
    source: string,
    dest: Destination,
    pick: PickName,
  ): Promise<Transfer> {
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
    const planned = await this.plan(await this.paths(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    const moving = sources.filter((source) => dirname(source) !== dest.path)
    for (const source of moving) {
      if (await exists(join(dest.path, basename(source)))) return fail('exists')
    }
    return this.transferAll(moving, (source) => this.moveNew(source, dest, sameName))
  }

  async copy(pathsInput: unknown, destInput: unknown): Promise<FileOpResult> {
    const planned = await this.plan(await this.paths(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    return this.transferAll(sources, (source) => this.copyNew(source, dest, copyOrSameName))
  }

  private dropped(input: unknown): Promise<string[] | null> {
    return everyPath(input, async (item) => {
      if (typeof item !== 'string' || !isAbsolute(item)) return null
      try {
        const real = join(await realpath(dirname(item)), basename(item))
        if ((await this.realRoots).includes(real) || !(await isDroppable(real))) return null
        return real
      } catch {
        return null
      }
    })
  }

  async importInto(pathsInput: unknown, destInput: unknown, move: boolean): Promise<FileOpResult> {
    const planned = await this.plan(await this.dropped(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    return this.transferAll(sources, async (source) => {
      if (!move) return this.copyNew(source, dest, numberedName)
      if (dirname(source) === dest.path) return { ok: true, target: source }
      return this.moveNew(source, dest, numberedName)
    })
  }

  async draggable(input: unknown): Promise<string | null> {
    const path = await this.entry(input)
    if (path === null) return null
    const info = await stat(path)
    return info?.isFile() || info?.isDirectory() ? path : null
  }

  async trash(pathsInput: unknown): Promise<FileOpResult> {
    const sources = await this.paths(pathsInput)
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
