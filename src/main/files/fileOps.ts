import type { Stats } from 'node:fs'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type { FileOpResult } from '../../shared/files/fileOps'
import { isInsidePath, resolveSafe } from '../platform/pathGuard'
import { atTransferFs } from './atTransferFs'
import {
  copyExclusive,
  entryUnchanged,
  moveExclusive,
  PartialTransferError,
  type TransferEnd,
} from './exclusiveTransfer'
import { type FolderAnchor, openAnchor } from './folderAnchor'
import {
  homeTrashPlace,
  mountTopdir,
  moveToTrash,
  NoTrashError,
  topdirTrashPlace,
} from './freedesktopTrash'
import { macAt } from './macAt'
import { type EntryStat, nodeTransferFs, type TransferFs } from './transferFs'

const FILE_OP_MAX_PATHS = 500
const NAME_MAX_BYTES = 255
const COPY_NAME_TRIES = 1000
const CLAIM_TRIES = 20

export interface FileOpsDeps {
  roots: string[]
  trash: (path: string) => Promise<void>
  fs?: TransferFs
  platform?: NodeJS.Platform
  homeTrash?: string
  uid?: number
  topdirOf?: (path: string) => Promise<string>
  trashAllowedAt?: (topdir: string) => Promise<boolean>
}

type TrashOutcome = 'trashed' | 'failed' | 'no-trash'

function defaultHomeTrash(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'Trash')
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

function failure(error: unknown, done: string[]): FileOpFailure {
  if (error instanceof PartialTransferError) {
    return { ok: false, error: 'partial', paths: done, partial: [error.path] }
  }
  return { ok: false, error: 'failed', paths: done }
}

interface Destination {
  path: string
  stat: EntryStat
}

export class FileOps {
  private readonly realRoots: Promise<string[]>
  private readonly fs: TransferFs
  private readonly platform: NodeJS.Platform

  constructor(private readonly deps: FileOpsDeps) {
    this.platform = deps.platform ?? process.platform
    this.fs = deps.fs ?? (this.platform === 'darwin' ? atTransferFs(macAt) : nodeTransferFs)
    this.realRoots = Promise.all(
      deps.roots.map((root) =>
        realpath(root).then(
          (real) => [real],
          () => [],
        ),
      ),
    ).then((reals) => reals.flat())
  }

  private async anchored<T>(
    path: string,
    expected: EntryStat | null,
    run: (anchor: FolderAnchor) => Promise<T>,
  ): Promise<T> {
    const anchor = await openAnchor(this.fs, path, this.platform, expected)
    try {
      return await run(anchor)
    } finally {
      await anchor.close().catch(() => {})
    }
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
      return roots.some((root) => isInsidePath(root, real)) ? { path: real, stat: info } : null
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
      return await this.anchored(parent.path, parent.stat, async (anchor) => {
        const from = { anchor, name: basename(source) }
        const to = { anchor, name: name as string }
        const renameAnchored = async () =>
          this.fs.rename(await anchor.at(from.name), await anchor.at(to.name))
        if (await sameEntry(source, target)) await renameAnchored()
        else {
          const moved = await moveExclusive(this.fs, from, to, this.platform)
          if (moved === 'taken') return fail('exists')
          if (moved === 'copy') {
            if (await exists(target)) return fail('exists')
            await renameAnchored()
          }
        }
        return { ok: true, paths: [target] } as const
      })
    } catch (error) {
      return failure(error, [])
    }
  }

  private async plan(
    sources: string[] | null,
    destInput: unknown,
  ): Promise<{ sources: string[]; dest: Destination } | FileOpFailure> {
    const dest = await this.destination(destInput)
    if (sources === null || dest === null) return fail('outside')
    if (sources.some((source) => isInsidePath(source, dest.path))) return fail('into-itself')
    return { sources, dest }
  }

  private async firstFreeName(
    source: TransferEnd,
    dest: FolderAnchor,
    pick: PickName,
    attempt: (target: TransferEnd) => Promise<Transfer | 'taken'>,
  ): Promise<Transfer> {
    for (let tries = 0; tries < CLAIM_TRIES; tries++) {
      const name = await pick(dest.path, source.name)
      if (name === null) return fail('exists')
      const sent = await attempt({ anchor: dest, name })
      if (sent !== 'taken') return sent
    }
    return fail('exists')
  }

  private copyNew(source: TransferEnd, dest: FolderAnchor, pick: PickName): Promise<Transfer> {
    return this.firstFreeName(source, dest, pick, async (target) =>
      (await copyExclusive(this.fs, source, target)) === 'done'
        ? { ok: true, target: join(dest.path, target.name) }
        : 'taken',
    )
  }

  private moveNew(source: TransferEnd, dest: FolderAnchor, pick: PickName): Promise<Transfer> {
    return this.firstFreeName(source, dest, pick, async (target) => {
      const moved = await moveExclusive(this.fs, source, target, this.platform)
      if (moved === 'copy') return this.copyThenTrash(source, dest, pick)
      return moved === 'done' ? { ok: true, target: join(dest.path, target.name) } : 'taken'
    })
  }

  private async copyThenTrash(
    source: TransferEnd,
    dest: FolderAnchor,
    pick: PickName,
  ): Promise<Transfer> {
    const before = await this.fs.lstat(await source.anchor.at(source.name))
    const copied = await this.copyNew(source, dest, pick)
    if (!copied.ok) return copied
    const trashed = await this.toTrash(source, before)
    if (trashed === 'trashed') return copied
    return {
      ok: false,
      error: trashed === 'no-trash' ? 'no-trash' : 'not-moved',
      paths: [copied.target],
    }
  }

  private async toTrash(source: TransferEnd, expected: EntryStat): Promise<TrashOutcome> {
    try {
      if (this.platform !== 'linux') {
        if (!(await entryUnchanged(this.fs, source, expected))) return 'failed'
        await this.deps.trash(join(source.anchor.path, source.name))
        return 'trashed'
      }
      const home = this.deps.homeTrash ?? defaultHomeTrash()
      const uid = this.deps.uid ?? process.getuid?.() ?? 0
      const place =
        (await homeTrashPlace(home, expected.dev)) ??
        (await topdirTrashPlace(
          await (this.deps.topdirOf ?? mountTopdir)(source.anchor.path),
          uid,
          expected.dev,
          this.deps.trashAllowedAt,
        ))
      const trashed = await moveToTrash(this.fs, source, expected, place, uid, new Date())
      return trashed ? 'trashed' : 'failed'
    } catch (error) {
      return error instanceof NoTrashError ? 'no-trash' : 'failed'
    }
  }

  private async transferAll(
    sources: string[],
    dest: Destination,
    send: (source: TransferEnd, dest: FolderAnchor) => Promise<Transfer>,
  ): Promise<FileOpResult> {
    const done: string[] = []
    try {
      return await this.anchored(dest.path, dest.stat, async (destAnchor) => {
        for (const source of sources) {
          const sent = await this.anchored(dirname(source), null, (sourceAnchor) =>
            send({ anchor: sourceAnchor, name: basename(source) }, destAnchor),
          )
          if (!sent.ok) {
            return { ok: false, error: sent.error, paths: [...done, ...(sent.paths ?? [])] }
          }
          done.push(sent.target)
        }
        return { ok: true, paths: done } as const
      })
    } catch (error) {
      return failure(error, done)
    }
  }

  async move(pathsInput: unknown, destInput: unknown): Promise<FileOpResult> {
    const planned = await this.plan(await this.paths(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    const moving = sources.filter((source) => dirname(source) !== dest.path)
    for (const source of moving) {
      if (await exists(join(dest.path, basename(source)))) return fail('exists')
    }
    return this.transferAll(moving, dest, (source, anchor) =>
      this.moveNew(source, anchor, sameName),
    )
  }

  async copy(pathsInput: unknown, destInput: unknown): Promise<FileOpResult> {
    const planned = await this.plan(await this.paths(pathsInput), destInput)
    if ('ok' in planned) return planned
    const { sources, dest } = planned
    return this.transferAll(sources, dest, (source, anchor) =>
      this.copyNew(source, anchor, copyOrSameName),
    )
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
    return this.transferAll(sources, dest, async (source, anchor) => {
      if (!move) return this.copyNew(source, anchor, numberedName)
      if (source.anchor.path === dest.path) {
        return { ok: true, target: join(dest.path, source.name) }
      }
      return this.moveNew(source, anchor, numberedName)
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
      const trashed = await this.anchored(dirname(source), null, async (anchor) => {
        const end = { anchor, name: basename(source) }
        return this.toTrash(end, await this.fs.lstat(await anchor.at(end.name)))
      }).catch((): TrashOutcome => 'failed')
      if (trashed !== 'trashed') return { ok: false, error: trashed, paths: done }
      done.push(source)
    }
    return { ok: true, paths: done }
  }
}
