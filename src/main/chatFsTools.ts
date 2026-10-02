import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CHAT_TOOL_OUTPUT_MAX } from '../shared/assist'
import { CHAT_EDITS_MAX, applyEdits } from '../shared/chatEdits'
import {
  CHAT_LIST_MAX,
  CHAT_QUERY_MAX,
  CHAT_READ_FILE_MAX,
  CHAT_READ_LINES_MAX,
  CHAT_SEARCH_FILES_MAX,
  CHAT_SEARCH_FILE_MAX,
  CHAT_SEARCH_MATCHES_MAX,
  CHAT_WRITE_MAX,
  type ChatDirEntry,
  type ChatFsError,
  type ChatFsFailure,
  type ChatFsResult,
  type ChatFsTarget,
  type ChatListOutput,
  type ChatPlanOutput,
  type ChatPlanRequest,
  type ChatPreviewOutput,
  type ChatReadOutput,
  type ChatReadRequest,
  type ChatSearchMatch,
  type ChatSearchOutput,
  type ChatSearchRequest,
  type ChatUndoOutput,
  type ChatUndoRequest,
  type ChatWriteOutput,
  type ChatWriteRequest,
} from '../shared/chatTools'
import { expandHome, resolveSafe } from './pathGuard'

const PATH_MAX = 4096
const READ_TEXT_MAX = CHAT_TOOL_OUTPUT_MAX - 2000
const SEARCH_LINE_MAX = 200
const BINARY_SNIFF = 8192
const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

type Fail = ChatFsFailure

export function versionOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function fail(error: ChatFsError, path?: string): Fail {
  return path ? { ok: false, error, path } : { ok: false, error }
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function realOfNearest(path: string): string | null {
  let current = path
  for (;;) {
    if (existsSync(current)) return realOrNull(current)
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

interface Located {
  path: string
  real: string
  outside: boolean
  symlink: boolean
}

function nearestExisting(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

function throughSymlink(path: string, real: string, folder: string | null): boolean {
  const nearest = nearestExisting(path)
  const realFolder = folder ? realOrNull(folder) : null
  if (folder && realFolder && inside(folder, nearest)) {
    return real !== resolve(realFolder, relative(folder, nearest))
  }
  return real !== nearest
}

export function locate(req: ChatFsTarget, roots: readonly string[]): Located | Fail {
  if (typeof req?.path !== 'string' || !req.path || req.path.length > PATH_MAX) {
    return fail('invalid')
  }
  if (!isAbsolute(expandHome(req.path))) return fail('invalid', req.path)
  const path = resolveSafe(req.path, [...roots])
  if (!path) return fail('not-allowed', req.path)
  const realRoots = roots.map((r) => realOrNull(resolve(expandHome(r)))).filter(Boolean)
  const real = realOfNearest(path)
  if (!real || !realRoots.some((r) => inside(r as string, real))) return fail('not-allowed', path)
  const folder = typeof req.root === 'string' ? resolveSafe(req.root, [...roots]) : null
  const realFolder = folder ? realOrNull(folder) : null
  const outside = !realFolder || !inside(realFolder, real)
  if (outside && req.outside !== true) return fail('outside-folder', path)
  return { path, real, outside, symlink: throughSymlink(path, real, folder) }
}

function isFail(v: unknown): v is Fail {
  return typeof v === 'object' && v !== null && (v as Fail).ok === false
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF).includes(0)
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export async function readTool(
  req: ChatReadRequest,
  roots: readonly string[],
): Promise<ChatFsResult<ChatReadOutput>> {
  const at = locate(req, roots)
  if (isFail(at)) return at
  try {
    const info = await stat(at.path)
    if (!info.isFile()) return fail('not-a-file', at.path)
    if (info.size > CHAT_READ_FILE_MAX) return fail('too-large', at.path)
    const buf = await readFile(at.path)
    if (looksBinary(buf)) return fail('binary', at.path)
    const lines = buf.toString('utf8').split('\n')
    const totalLines = lines.length
    const startLine = clampInt(req.offset, 1, Math.max(1, totalLines), 1)
    const limit = clampInt(req.limit, 1, CHAT_READ_LINES_MAX, CHAT_READ_LINES_MAX)
    const picked: string[] = []
    let size = 0
    let truncated = false
    for (let i = startLine - 1; i < totalLines && picked.length < limit; i++) {
      const line = lines[i]
      if (size + line.length + 1 > READ_TEXT_MAX) {
        truncated = true
        break
      }
      picked.push(line)
      size += line.length + 1
    }
    const endLine = startLine + picked.length - 1
    if (endLine < totalLines) truncated = true
    return {
      ok: true,
      path: at.path,
      text: picked.join('\n'),
      startLine,
      endLine,
      totalLines,
      truncated,
      version: versionOf(buf),
    }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? fail('not-found', at.path)
      : fail('failed', at.path)
  }
}

export async function listTool(
  req: ChatFsTarget,
  roots: readonly string[],
): Promise<ChatFsResult<ChatListOutput>> {
  const at = locate(req, roots)
  if (isFail(at)) return at
  try {
    const info = await stat(at.path)
    if (!info.isDirectory()) return fail('not-a-directory', at.path)
    const dirents = await readdir(at.path, { withFileTypes: true })
    dirents.sort((a, b) => {
      const da = a.isDirectory() ? 0 : 1
      const db = b.isDirectory() ? 0 : 1
      return da - db || a.name.localeCompare(b.name)
    })
    const entries: ChatDirEntry[] = []
    for (const d of dirents.slice(0, CHAT_LIST_MAX)) {
      if (d.isDirectory()) entries.push({ name: d.name, kind: 'dir' })
      else if (d.isFile()) {
        const size = await lstat(join(at.path, d.name)).then(
          (s) => s.size,
          () => undefined,
        )
        entries.push(
          size === undefined
            ? { name: d.name, kind: 'file' }
            : { name: d.name, kind: 'file', size },
        )
      } else entries.push({ name: d.name, kind: 'other' })
    }
    return { ok: true, path: at.path, entries, truncated: dirents.length > CHAT_LIST_MAX }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? fail('not-found', at.path)
      : fail('failed', at.path)
  }
}

async function searchFile(file: string, needle: string, out: ChatSearchMatch[]): Promise<void> {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (info.size > CHAT_SEARCH_FILE_MAX) return
    const buf = await handle.readFile()
    if (looksBinary(buf)) return
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length && out.length < CHAT_SEARCH_MATCHES_MAX; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        out.push({ path: file, line: i + 1, text: lines[i].trim().slice(0, SEARCH_LINE_MAX) })
      }
    }
  } finally {
    await handle.close()
  }
}

export async function searchTool(
  req: ChatSearchRequest,
  roots: readonly string[],
): Promise<ChatFsResult<ChatSearchOutput>> {
  const query = typeof req?.query === 'string' ? req.query.trim() : ''
  if (!query || query.length > CHAT_QUERY_MAX) return fail('invalid')
  const at = locate(req, roots)
  if (isFail(at)) return at
  const needle = query.toLowerCase()
  const matches: ChatSearchMatch[] = []
  let files = 0
  let truncated = false
  const queue = [at.path]
  try {
    const info = await stat(at.path)
    if (!info.isDirectory()) return fail('not-a-directory', at.path)
    while (queue.length > 0) {
      const dir = queue.shift() as string
      const dirents = await readdir(dir, { withFileTypes: true }).catch(() => [])
      dirents.sort((a, b) => a.name.localeCompare(b.name))
      for (const d of dirents) {
        if (matches.length >= CHAT_SEARCH_MATCHES_MAX || files >= CHAT_SEARCH_FILES_MAX) {
          truncated = true
          break
        }
        const full = join(dir, d.name)
        if (d.isDirectory()) {
          if (!SKIPPED_DIRS.has(d.name)) queue.push(full)
          continue
        }
        if (!d.isFile()) continue
        files += 1
        if (d.name.toLowerCase().includes(needle)) matches.push({ path: full })
        await searchFile(full, needle, matches).catch(() => undefined)
      }
      if (truncated) break
    }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? fail('not-found', at.path)
      : fail('failed', at.path)
  }
  return {
    ok: true,
    path: at.path,
    matches: matches.map((m) => ({ ...m, path: relative(at.path, m.path) || m.path })),
    truncated,
  }
}

async function existingText(
  path: string,
): Promise<{ text: string; version: string } | Fail | null> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) return fail('not-a-file', path)
    if (info.size > CHAT_WRITE_MAX) return fail('too-large', path)
    const buf = await readFile(path)
    const text = buf.toString('utf8')
    if (looksBinary(buf) || !Buffer.from(text, 'utf8').equals(buf)) return fail('binary', path)
    return { text, version: versionOf(buf) }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : fail('failed', path)
  }
}

export async function previewTool(
  req: Omit<ChatFsTarget, 'outside'>,
  roots: readonly string[],
): Promise<ChatFsResult<ChatPreviewOutput>> {
  const at = locate({ ...req, outside: true }, roots)
  if (isFail(at)) return at
  const current = await existingText(at.path)
  if (isFail(current)) return current
  return {
    ok: true,
    path: at.path,
    exists: current !== null,
    text: current?.text ?? '',
    version: current?.version ?? null,
    outside: at.outside,
    symlink: at.symlink,
  }
}

export async function planEditTool(
  req: ChatPlanRequest,
  roots: readonly string[],
): Promise<ChatFsResult<ChatPlanOutput>> {
  const edits = Array.isArray(req?.edits) ? req.edits : []
  const valid = edits.every(
    (e) => typeof e?.oldText === 'string' && e.oldText !== '' && typeof e.newText === 'string',
  )
  if (edits.length === 0 || edits.length > CHAT_EDITS_MAX || !valid) return fail('invalid')
  const at = locate({ path: req.path, root: req.root, outside: req.outside === true }, roots)
  if (isFail(at)) return at
  const current = await existingText(at.path)
  if (isFail(current)) return current
  if (current === null) return fail('not-found', at.path)
  const result = applyEdits(current.text, edits)
  if (!result.ok) {
    const { ok: _ok, ...problem } = result
    return { ok: false, path: at.path, ...problem }
  }
  if (Buffer.byteLength(result.text) > CHAT_WRITE_MAX) return fail('too-large', at.path)
  return {
    ok: true,
    path: at.path,
    before: current.text,
    after: result.text,
    version: current.version,
    outside: at.outside,
    symlink: at.symlink,
  }
}

function writable(req: ChatFsTarget & { symlinks: boolean }, roots: readonly string[]) {
  const at = locate(req, roots)
  if (isFail(at)) return at
  return at.symlink && req.symlinks !== true ? fail('through-symlink', at.path) : at
}

export async function writeTool(
  req: ChatWriteRequest,
  roots: readonly string[],
): Promise<ChatFsResult<ChatWriteOutput>> {
  if (typeof req?.content !== 'string' || Buffer.byteLength(req.content) > CHAT_WRITE_MAX) {
    return fail('too-large')
  }
  const at = writable(req, roots)
  if (isFail(at)) return at
  const current = await existingText(at.path)
  if (isFail(current)) return current
  const base = typeof req.base === 'string' ? req.base : null
  if ((current?.version ?? null) !== base) return fail('changed', at.path)
  const created = current === null
  try {
    await mkdir(dirname(at.path), { recursive: true })
    const parent = realOrNull(dirname(at.path))
    const realRoots = roots.map((r) => realOrNull(resolve(expandHome(r)))).filter(Boolean)
    if (!parent || !realRoots.some((r) => inside(r as string, parent))) {
      return fail('not-allowed', at.path)
    }
    await writeFile(at.path, req.content, { encoding: 'utf8', flag: created ? 'wx' : 'w' })
    return {
      ok: true,
      path: at.path,
      created,
      bytes: Buffer.byteLength(req.content),
      version: versionOf(req.content),
    }
  } catch {
    return fail('failed', at.path)
  }
}

export async function undoTool(
  req: ChatUndoRequest,
  roots: readonly string[],
): Promise<ChatFsResult<ChatUndoOutput>> {
  const restore = req?.restore ?? null
  if (
    restore !== null &&
    (typeof restore !== 'string' || Buffer.byteLength(restore) > CHAT_WRITE_MAX)
  ) {
    return fail('too-large')
  }
  const at = writable(req, roots)
  if (isFail(at)) return at
  const current = await existingText(at.path)
  if (isFail(current)) return current
  if (current === null || current.version !== req.wrote) return fail('changed', at.path)
  try {
    if (restore === null) {
      await unlink(at.path)
      return { ok: true, path: at.path, removed: true, version: null }
    }
    await writeFile(at.path, restore, { encoding: 'utf8', flag: 'w' })
    return { ok: true, path: at.path, removed: false, version: versionOf(restore) }
  } catch {
    return fail('failed', at.path)
  }
}
